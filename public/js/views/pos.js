async function renderPos(view) {
  const session = State.getSession();
  const branchId = State.effectiveBranchId();

  // Restore any in-progress cart for THIS cashier at THIS branch (see the
  // persistence note above). Payments are deliberately NOT restored —
  // cash tendered is a live count at the drawer, not something to
  // resurrect from storage.
  posCart = [];
  posPayments = [{ method: 'CASH', amount: 0, cash_tendered: '' }];
  posSelectedCustomer = null;
  const restored = loadPosCart(session.user.id, branchId);
  if (restored) {
    posCart = restored.cart;
    posSelectedCustomer = restored.customer || null;
  }

  if (!branchId) {
    view.innerHTML = `<div class="card"><p>Select a branch (top-right branch switcher) to use the Point of Sale — sales must be recorded against one specific branch.</p></div>`;
    return;
  }

  const till = await Api.get(`/till/current?branch_id=${branchId}`).catch(() => null);

  view.innerHTML = `
    <h2 class="page-title">Point of Sale</h2>
    <p class="page-subtitle">Branch-scoped sales with FEFO batch picking, pack/carton pricing, and controlled-drug / prescription compliance checks.</p>

    ${!till ? `<div class="card" style="border-left:4px solid var(--amber-500);"><b>No till session is open.</b> Open a till before making sales so cash reconciliation stays accurate. <a href="#/till" style="color:var(--green-700);font-weight:600;">Go to Till →</a></div>` : ''}

    <div class="pos-layout">
      <div>
        <div class="card">
          <h3>Find Product</h3>
          <div class="form-row" style="margin-bottom:8px;">
            <label for="pos-retail-category">Retail Category</label>
            <select id="pos-retail-category">${UI.retailCategoryOptions('ALL', true, 'All sellable categories')}</select>
            <small class="muted">Choose Pharmaceuticals, Food &amp; Drinks, Accessories or Beauty &amp; Personal Care to limit the product list.</small>
          </div>
          <div class="form-inline" style="align-items:flex-end;gap:8px;">
            <div class="form-row" style="flex:1;margin-bottom:0;"><label for="pos-barcode">Scan or enter barcode</label><input type="text" id="pos-barcode" inputmode="numeric" autocomplete="off" placeholder="Scan EAN/UPC/GTIN then Enter" /></div>
            <button id="pos-barcode-add" class="btn btn-secondary" type="button">Add barcode</button>
          </div>
          <small class="muted" style="display:block;margin:6px 0 8px;font-size:12px;">USB/Bluetooth scanners usually type the code then send Enter. Product, pack and carton barcodes can each add the correct selling unit.</small>
          <input type="text" id="pos-search" placeholder="Search by name, generic name, NAFDAC no. or barcode..." autocomplete="off" />
          <div id="pos-search-results" class="product-search-results hidden"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Cart</h3>
          <div id="pos-cart"></div>
          <div id="pos-totals"></div>
          <div class="form-row" style="margin-top:10px;">
            <label>Discount (N)</label>
            <input type="number" id="pos-discount" value="0" min="0" />
          </div>
          <div id="pos-customer-row" class="form-row hidden">
            <label>Customer (required for credit sale)</label>
            <input type="text" id="pos-customer-search" placeholder="Search customer by name/phone..." autocomplete="off" />
            <div id="pos-customer-results" class="product-search-results hidden"></div>
            <div id="pos-customer-selected" style="margin-top:6px;font-size:12px;color:var(--green-700);"></div>
          </div>
          <!-- BUG 95: shown only when the cashier says change is owed. A NAME
               or a PHONE is enough — demanding a full customer record at a
               busy counter is how the feature would go unused, and unused
               means the cashier goes back to remembering. -->
          <div id="pos-change-owed-row" class="form-row hidden">
            <label>Who is the change for?</label>
            <input type="text" id="pos-change-name" placeholder="Customer name" autocomplete="off" />
            <input type="text" id="pos-change-phone" placeholder="Phone number" autocomplete="off" style="margin-top:6px;" />
            <small class="muted" style="display:block;margin-top:4px;font-size:12px;">Name or phone — either is enough. They will get a 7-digit claim code on the receipt.</small>
          </div>
          <h4 style="margin:14px 0 6px;font-size:13px;">Payment</h4>
          <div id="pos-payments"></div>
          <button id="pos-add-payment" class="btn btn-secondary btn-sm" style="margin-top:6px;">+ Add payment method</button>
          <button id="pos-checkout" class="btn btn-primary" style="width:100%;margin-top:14px;" ${till ? '' : 'disabled title="Open a till first"'}>Complete Sale</button>
        </div>
      </div>
    </div>
  `;

  function renderCart() {
    // Single chokepoint: every add, remove and quantity change already
    // calls this, so persisting here guarantees the saved cart can never
    // drift from what the cashier sees on screen.
    savePosCart(session.user.id, branchId);
    const cartEl = document.getElementById('pos-cart');
    if (posCart.length === 0) {
      cartEl.innerHTML = '<div class="empty-state">Cart is empty — search a product to add it.</div>';
    } else {
      cartEl.innerHTML = posCart.map((line, idx) => `
        <div class="cart-line">
          <div>
            <div class="name">${UI.escapeHtml(line.product.name)} ${line.product.is_controlled ? UI.badge('CONTROLLED', 'red') : ''} ${line.product.dispensing_type === 'POM' ? UI.badge('POM', 'amber') : ''}</div>
            <div class="meta">${UI.money(line.unitPrice)} / ${line.unitType.toLowerCase()}</div>
          </div>
          <input type="number" min="1" step="1" class="qty-input" value="${line.quantity}" data-qty-idx="${idx}" />
          <div style="width:70px;text-align:right;font-weight:600;">${UI.money(line.unitPrice * line.quantity)}</div>
          <button class="remove-line" data-remove-idx="${idx}" aria-label="Remove">✕</button>
        </div>
      `).join('');
      cartEl.querySelectorAll('[data-qty-idx]').forEach((inp) => {
        inp.addEventListener('change', () => {
          const idx = Number(inp.dataset.qtyIdx);
          posCart[idx].quantity = Math.max(1, Number(inp.value) || 1);
          renderCart();
        });
      });
      cartEl.querySelectorAll('[data-remove-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          posCart.splice(Number(btn.dataset.removeIdx), 1);
          renderCart();
        });
      });
    }
    renderTotals();
  }

  function subtotal() {
    return posCart.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  }

  function renderTotals() {
    const discountEl = document.getElementById('pos-discount');
    const discount = Number((discountEl && discountEl.value) || 0);
    const sub = subtotal();
    const total = Math.max(0, sub - discount);
    document.getElementById('pos-totals').innerHTML = `
      <div class="cart-total-row"><span>Subtotal</span><span>${UI.money(sub)}</span></div>
      <div class="cart-total-row"><span>Discount</span><span>-${UI.money(discount)}</span></div>
      <div class="cart-total-row grand"><span>Total</span><span>${UI.money(total)}</span></div>
    `;
    renderPayments();
  }

  function renderPayments() {
    const el = document.getElementById('pos-payments');
    el.innerHTML = posPayments.map((p, idx) => `
      <div class="form-inline" style="margin-bottom:8px;">
        <div class="form-row">
          <label>Method</label>
          <select data-pay-method="${idx}">
            ${['CASH', 'POS_CARD', 'TRANSFER', 'CREDIT'].map(m => `<option value="${m}" ${p.method === m ? 'selected' : ''}>${m.replace('_', ' ')}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>Amount</label>
          <input type="number" min="0" data-pay-amount="${idx}" value="${p.amount}" />
        </div>
        ${p.method === 'CASH' ? `
        <div class="form-row">
          <label>Cash Tendered</label>
          <input type="number" min="0" data-pay-tendered="${idx}" value="${p.cash_tendered}" placeholder="if different" />
        </div>
        <!-- BUG 95. The commonest event at a Nigerian counter: the customer
             hands over more than the sale and the drawer has no note to give
             back. Before this field the sale recorded the change as PAID,
             which was untrue, left a phantom overage in the till, and left the
             customer's claim living only in the cashier's memory. -->
        <div class="form-row">
          <label>Change Owed (no note to give)</label>
          <input type="number" min="0" data-pay-owed="${idx}" value="${p.change_owed || ''}" placeholder="0" />
          <small class="muted" style="display:block;margin-top:4px;font-size:12px;">Leave blank if you gave the full change.</small>
        </div>` : ''}
        ${posPayments.length > 1 ? `<button class="remove-line" data-remove-payment="${idx}" aria-label="Remove">✕</button>` : ''}
      </div>
    `).join('');
    if (posPayments.some(p => p.method === 'CREDIT')) {
      document.getElementById('pos-customer-row').classList.remove('hidden');
    } else {
      document.getElementById('pos-customer-row').classList.add('hidden');
    }
    syncChangeOwedCustomerRow();

    el.querySelectorAll('[data-pay-method]').forEach((sel) => sel.addEventListener('change', () => {
      posPayments[Number(sel.dataset.payMethod)].method = sel.value;
      renderTotals();
    }));
    el.querySelectorAll('[data-pay-amount]').forEach((inp) => inp.addEventListener('input', () => {
      posPayments[Number(inp.dataset.payAmount)].amount = Number(inp.value) || 0;
    }));
    // Mobile input stability: calling renderTotals() here used to rebuild
    // #pos-payments on EVERY digit. That replaces the focused <input>, which
    // dismisses Android/iOS's numeric keyboard after the first character. Cash
    // tendered affects no displayed total, so state can update in place. Change
    // owed only needs to reveal/hide the customer-claim row, which we toggle
    // without replacing this focused field. Structural changes (method/add/
    // remove) still use the full render below.
    el.querySelectorAll('[data-pay-tendered]').forEach((inp) => inp.addEventListener('input', () => {
      const raw = inp.value;
      posPayments[Number(inp.dataset.payTendered)].cash_tendered = raw === '' ? '' : (Number(raw) || 0);
    }));
    el.querySelectorAll('[data-pay-owed]').forEach((inp) => inp.addEventListener('input', () => {
      const raw = inp.value;
      posPayments[Number(inp.dataset.payOwed)].change_owed = raw === '' ? '' : (Number(raw) || 0);
      syncChangeOwedCustomerRow();
    }));
    el.querySelectorAll('[data-remove-payment]').forEach((btn) => btn.addEventListener('click', () => {
      posPayments.splice(Number(btn.dataset.removePayment), 1);
      renderTotals();
    }));
  }

  function syncChangeOwedCustomerRow() {
    const owesChange = posPayments.some((p) => p.method === 'CASH' && Number(p.change_owed) > 0);
    const row = document.getElementById('pos-change-owed-row');
    if (row) row.classList.toggle('hidden', !owesChange);
  }

  document.getElementById('pos-add-payment').addEventListener('click', () => {
    posPayments.push({ method: 'CASH', amount: 0, cash_tendered: '' });
    renderTotals();
  });

  document.getElementById('pos-discount').addEventListener('input', renderTotals);

  // Product search and retail-category selling. The category filter works
  // with or without typed search text so a counter can deliberately switch
  // from medicines to drinks/beauty/accessories without memorising names.
  const outsideClickHandler = (e) => {
    if (!e.target.closest('#pos-search') && !e.target.closest('#pos-search-results') && !e.target.closest('#pos-retail-category')) {
      const resultsEl = document.getElementById('pos-search-results');
      if (resultsEl) resultsEl.classList.add('hidden');
    }
  };
  let searchTimer;
  let latestSearch = 0;
  async function loadProductResults() {
    const searchInput = document.getElementById('pos-search');
    const categoryInput = document.getElementById('pos-retail-category');
    const resultsEl = document.getElementById('pos-search-results');
    const q = searchInput.value.trim();
    const retailCategory = categoryInput.value;
    if (!q && retailCategory === 'ALL') { resultsEl.classList.add('hidden'); return; }
    const sequence = ++latestSearch;
    let url = `/products?${q ? `q=${encodeURIComponent(q)}` : ''}`;
    if (retailCategory !== 'ALL') url += `${q ? '&' : ''}retail_category=${encodeURIComponent(retailCategory)}`;
    try {
      const products = await Api.get(url);
      // A slower response from an earlier keypress/category must never replace
      // the current category's result list.
      if (sequence !== latestSearch) return;
      if (!products.length) {
        resultsEl.innerHTML = `<div class="product-search-item">No ${retailCategory === 'ALL' ? '' : UI.escapeHtml(UI.retailCategoryLabel(retailCategory).toLowerCase() + ' ')}products found</div>`;
      } else {
        resultsEl.innerHTML = products.map((product) => `
          <div class="product-search-item" data-product-id="${product.id}">
            <div>
              <div>${UI.escapeHtml(product.name)} ${product.is_controlled ? UI.badge('CTRL', 'red') : ''} ${product.dispensing_type === 'POM' ? UI.badge('POM', 'amber') : ''}</div>
              <div class="meta">${UI.escapeHtml(UI.retailCategoryLabel(product.retail_category))} · ${UI.escapeHtml(product.generic_name || product.category || '')} · ${UI.escapeHtml(product.base_unit)}</div>
            </div>
            <span>Add →</span>
          </div>
        `).join('');
        resultsEl.querySelectorAll('[data-product-id]').forEach((item) => {
          item.addEventListener('click', async () => {
            const product = products.find((entry) => entry.id === item.dataset.productId);
            searchInput.value = '';
            resultsEl.classList.add('hidden');
            await addProductToCart(product, branchId, renderCart);
          });
        });
      }
      resultsEl.classList.remove('hidden');
    } catch (e) { UI.toast(e.message || 'Could not load products for this category.', 'error'); }
  }
  function scheduleProductSearch(delay) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadProductResults, delay == null ? 250 : delay);
  }
  document.getElementById('pos-search').addEventListener('input', () => scheduleProductSearch());
  document.getElementById('pos-retail-category').addEventListener('change', () => scheduleProductSearch(0));
  async function addScannedBarcode() {
    const input = document.getElementById('pos-barcode');
    const raw = input.value.trim();
    if (!raw) { UI.toast('Scan a barcode or enter the product code, then choose Add barcode.', 'error'); return; }
    try {
      const scanned = await Api.get(`/products/barcode/${encodeURIComponent(raw)}`);
      input.value = '';
      await addProductToCart(scanned, branchId, renderCart, scanned.barcode_unit_type, scanned.barcode);
      input.focus();
    } catch (e) { UI.toast(e.message || 'Barcode could not be added.', 'error'); }
  }
  UI.guardedClick(document.getElementById('pos-barcode-add'), addScannedBarcode);
  document.getElementById('pos-barcode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addScannedBarcode(); }
  });
  document.addEventListener('click', outsideClickHandler);
  Router.onCleanup(() => { document.removeEventListener('click', outsideClickHandler); clearTimeout(searchTimer); });

  // Customer search (for credit sales)
  let custTimer;
  UI.on('pos-customer-search', 'input', (e) => {
    clearTimeout(custTimer);
    const q = e.target.value.trim();
    if (!q) return;
    custTimer = setTimeout(async () => {
      const customers = await Api.get(`/customers?q=${encodeURIComponent(q)}&branch_id=${branchId}`);
      const resultsEl = document.getElementById('pos-customer-results');
      resultsEl.innerHTML = customers.length
        ? customers.map(c => `<div class="product-search-item" data-cust-id="${c.id}"><div>${UI.escapeHtml(c.name)}<div class="meta">${UI.escapeHtml(c.phone || '')}</div></div></div>`).join('')
        : `<div class="product-search-item">No match — <a href="#/customers">add a new customer</a></div>`;
      resultsEl.classList.remove('hidden');
      resultsEl.querySelectorAll('[data-cust-id]').forEach((item) => {
        item.addEventListener('click', () => {
          posSelectedCustomer = customers.find(c => c.id === item.dataset.custId);
          document.getElementById('pos-customer-selected').textContent = `Selected: ${posSelectedCustomer.name}`;
          resultsEl.classList.add('hidden');
        });
      });
    }, 250);
  });

  document.getElementById('pos-checkout').addEventListener('click', () => checkout(branchId, till, renderCart));

  posRerenderCart = renderCart;
  renderCart();
}

async function addProductToCart(product, branchId, rerenderCart, scannedUnitType, scannedBarcode) {
  const unitOptions = ['BASE_UNIT'];
  if (product.units_per_pack > 1) unitOptions.push('PACK');
  if (product.packs_per_carton > 1) unitOptions.push('CARTON');

  let unitType = scannedUnitType || 'BASE_UNIT';
  if (scannedUnitType && !unitOptions.includes(scannedUnitType)) {
    UI.toast(`This barcode is registered as ${scannedUnitType}, but this product's pack/carton setup is incomplete. Ask a manager to correct the product barcode setup.`, 'error');
    return;
  }
  if (!scannedUnitType && unitOptions.length > 1) {
    unitType = await pickUnitType(product, unitOptions);
    if (!unitType) return;
  }

  const batches = await Api.get(`/stock?branch_id=${branchId}&product_id=${product.id}`);
  if (!batches.length) {
    // OUT OF STOCK — the one moment a therapeutic alternative is actually
    // useful. Rather than a dead-end toast, offer other products this branch
    // HAS ON THE SHELF that share the same active ingredient.
    await offerInStockAlternatives(product, branchId, rerenderCart);
    return;
  }
  const batch = batches[0]; // batches already come back FEFO-ordered from the API
  const priceField = unitType === 'PACK' ? 'pack_price' : unitType === 'CARTON' ? 'carton_price' : 'selling_price_per_unit';
  const unitPrice = batch[priceField];
  if (unitPrice == null) { UI.toast(`No ${unitType} price set for ${product.name}; sell as base unit or ask manager to set pack/carton pricing.`, 'error'); return; }

  let prescription = null, controlled_kyc = null;
  if (product.dispensing_type === 'POM') {
    prescription = await promptPrescription(product);
    if (!prescription) return;
  }
  if (product.is_controlled) {
    controlled_kyc = await promptControlledKyc(product);
    if (!controlled_kyc) return;
  }

  const existingLine = posCart.find(l => l.product.id === product.id && l.unitType === unitType && l.scannedBarcode === (scannedBarcode || null) && !prescription && !controlled_kyc);
  if (existingLine) {
    existingLine.quantity += 1;
  } else {
    posCart.push({ product, unitType, quantity: 1, unitPrice, prescription, controlled_kyc, scannedBarcode: scannedBarcode || null });
  }
  rerenderCart();
  UI.toast(`${product.name} added to cart`, 'success', 1800);
}

function pickUnitType(product, options) {
  return new Promise((resolve) => {
    const labels = { BASE_UNIT: `Single ${product.base_unit}`, PACK: `Pack (${product.units_per_pack} ${product.base_unit}s)`, CARTON: `Carton (${product.packs_per_carton} packs)` };
    const modal = UI.openModal(`
      <h3>Sell "${UI.escapeHtml(product.name)}" as?</h3>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${options.map(o => `<button class="btn btn-secondary" data-unit="${o}">${labels[o]}</button>`).join('')}
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="cancel-unit">Cancel</button></div>
    `);
    modal.querySelectorAll('[data-unit]').forEach((btn) => btn.addEventListener('click', () => {
      UI.closeModal(modal);
      resolve(btn.dataset.unit);
    }));
    modal.querySelector('#cancel-unit').addEventListener('click', () => { UI.closeModal(modal); resolve(null); });
  });
}

// Called when the requested product has no stock at this branch. Looks up
// products the branch DOES have that share the same active ingredient, so the
// cashier can offer a substitute instead of turning the customer away.
//
// Deliberately fails soft: if the lookup errors, or the product has no
// recorded generic/ingredient, the cashier still gets the plain
// "no stock" message and the sale continues as before. A convenience feature
// must never block the till.
async function offerInStockAlternatives(product, branchId, rerenderCart) {
  // The ingredient key is derived the same way the catalog importer derives
  // it — lowercase, punctuation collapsed to single spaces — so a product
  // whose generic_name came from the catalog matches its catalog siblings.
  const key = String(product.generic_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!key) { UI.toast(`No stock of ${product.name} at this branch`, 'error'); return; }

  let alts = [];
  try {
    alts = await Api.get(`/catalog/in-stock-alternatives?ingredient_key=${encodeURIComponent(key)}&branch_id=${branchId}&limit=8`);
  } catch (e) { /* fall through to the plain message */ }

  alts = (alts || []).filter((a) => a.id !== product.id);
  if (!alts.length) { UI.toast(`No stock of ${product.name} at this branch`, 'error'); return; }

  const modal = UI.openModal(`
    <h3>${UI.escapeHtml(product.name)} is out of stock</h3>
    <p style="font-size:13px;color:var(--gray-600);">
      These products are in stock at this branch and contain the same active ingredient
      (<strong>${UI.escapeHtml(product.generic_name || '')}</strong>).
      Confirm suitability with the pharmacist before substituting.
    </p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Product</th><th>Available</th><th>Type</th><th></th></tr></thead>
        <tbody>
          ${alts.map((a) => `
            <tr>
              <td>${UI.escapeHtml(a.name)}<div class="meta">${UI.escapeHtml(a.generic_name || '')}</div></td>
              <td>${a.quantity_available} ${UI.escapeHtml(a.base_unit || '')}</td>
              <td>${a.is_controlled ? UI.badge('Controlled', 'red') : ''}${a.dispensing_type === 'POM' ? UI.badge('POM', 'amber') : UI.badge('OTC', 'gray')}</td>
              <td><button class="btn btn-primary btn-sm" data-alt-product="${a.id}">Add to cart</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="modal-actions"><button class="btn btn-secondary" id="alt-cancel">Cancel</button></div>
  `);

  modal.querySelector('#alt-cancel').addEventListener('click', () => UI.closeModal(modal));
  modal.querySelectorAll('[data-alt-product]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      UI.closeModal(modal);
      const chosen = alts.find((a) => a.id === btn.dataset.altProduct);
      if (!chosen) return;
      // Re-enter the normal add-to-cart path so the substitute goes through
      // the SAME prescription / controlled-KYC / pricing checks. Substituting
      // must never be a way to bypass a compliance prompt.
      // Pass the caller's cart-refresh callback through (falling back to the
      // module-scope one renderPos() set) so the substitute actually appears
      // in the cart without a full view reload.
      await addProductToCart(chosen, branchId, rerenderCart || posRerenderCart);
    });
  });
}

function promptPrescription(product) {
  return new Promise((resolve) => {
    const modal = UI.openModal(`
      <h3>Prescription details — ${UI.escapeHtml(product.name)}</h3>
      <p class="page-subtitle">This is a Prescription-Only Medicine (POM). PCN regulations require prescriber and patient details.</p>
      <div class="form-row"><label>Prescriber Name (Doctor/Clinic)</label><input id="rx-prescriber" /></div>
      <div class="form-row"><label>Prescriber PCN/MDCN No.</label><input id="rx-license" /></div>
      <div class="form-row"><label>Patient Name</label><input id="rx-patient" /></div>
      <div class="form-row"><label>Patient Phone</label><input id="rx-phone" /></div>
      <div class="form-row"><label>Dosage Notes</label><textarea id="rx-dosage" rows="2"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="rx-cancel">Cancel</button>
        <button class="btn btn-primary" id="rx-save">Save &amp; Add to Cart</button>
      </div>
    `);
    modal.querySelector('#rx-cancel').addEventListener('click', () => { UI.closeModal(modal); resolve(null); });
    modal.querySelector('#rx-save').addEventListener('click', () => {
      const prescriber_name = modal.querySelector('#rx-prescriber').value.trim();
      const patient_name = modal.querySelector('#rx-patient').value.trim();
      if (!prescriber_name || !patient_name) { UI.toast('Prescriber and patient name are required', 'error'); return; }
      UI.closeModal(modal);
      resolve({
        prescriber_name,
        prescriber_pcn_or_mdcn_no: modal.querySelector('#rx-license').value.trim(),
        patient_name,
        patient_phone: modal.querySelector('#rx-phone').value.trim(),
        dosage_notes: modal.querySelector('#rx-dosage').value.trim(),
      });
    });
  });
}

function promptControlledKyc(product) {
  return new Promise((resolve) => {
    const modal = UI.openModal(`
      <h3>Controlled substance buyer KYC — ${UI.escapeHtml(product.name)}</h3>
      <p class="page-subtitle">PCN/NAFDAC regulations require identifying the buyer of controlled drugs (e.g. Tramadol, Codeine).</p>
      <div class="form-row"><label>Buyer Name</label><input id="kyc-name" /></div>
      <div class="form-row"><label>Buyer Phone</label><input id="kyc-phone" /></div>
      <div class="form-row"><label>ID Type</label><input id="kyc-idtype" placeholder="NIN / Voter's Card / Driver's Licence" /></div>
      <div class="form-row"><label>ID Number</label><input id="kyc-idnum" /></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="kyc-cancel">Cancel</button>
        <button class="btn btn-primary" id="kyc-save">Save &amp; Add to Cart</button>
      </div>
    `);
    modal.querySelector('#kyc-cancel').addEventListener('click', () => { UI.closeModal(modal); resolve(null); });
    modal.querySelector('#kyc-save').addEventListener('click', () => {
      const buyer_name = modal.querySelector('#kyc-name').value.trim();
      const buyer_phone = modal.querySelector('#kyc-phone').value.trim();
      if (!buyer_name || !buyer_phone) { UI.toast('Buyer name and phone are required for controlled drugs', 'error'); return; }
      UI.closeModal(modal);
      resolve({ buyer_name, buyer_phone, buyer_id_type: modal.querySelector('#kyc-idtype').value.trim(), buyer_id_number: modal.querySelector('#kyc-idnum').value.trim() });
    });
  });
}

async function checkout(branchId, till, rerenderCart) {
  // `checkout()` lives outside renderPos() so it can be reused by the button
  // handler, but that also means it cannot see renderPos's local `session`.
  // The sale was correctly committed by the API, then the old code threw
  // "session is not defined" while clearing the saved cart — a cashier saw an
  // error even though the dashboard later showed the sale. Read the live
  // session at the action boundary instead, then clear only this cashier's
  // cart after a definitive sale/queue outcome.
  const session = State.getSession();
  if (!session || !session.user) {
    UI.toast('Your session has ended. Please sign in again before completing this sale.', 'error');
    return;
  }
  if (posCart.length === 0) { UI.toast('Cart is empty', 'error'); return; }
  const discount = Number(document.getElementById('pos-discount').value || 0);
  const total = Math.max(0, posCart.reduce((s, l) => s + l.unitPrice * l.quantity, 0) - discount);
  const paidSum = posPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  if (Math.abs(paidSum - total) > 0.01) { UI.toast(`Payments (${UI.money(paidSum)}) must sum to the total (${UI.money(total)})`, 'error'); return; }
  if (posPayments.some(p => p.method === 'CREDIT') && !posSelectedCustomer) { UI.toast('Select a customer for the credit portion of this sale', 'error'); return; }

  // BUG 39 (client half). The server refuses a cash tender smaller than the
  // cash line it pays, because that stored a negative change_given — the
  // drawer handing money back to itself. Catching it HERE matters for one
  // specific reason: offline. A sale submitted while offline is queued, and
  // Offline.flush treats any 4xx on replay as PERMANENT and quarantines the
  // item. So a cashier who mis-keys the tender during a network drop would
  // lose the sale entirely rather than be told to fix a typo. Blank means
  // "exact money" (see the body builder below), so only a value the cashier
  // actually typed is checked.
  const shortTender = posPayments.find(p =>
    p.method === 'CASH'
    && p.cash_tendered !== '' && p.cash_tendered != null
    && Number(p.cash_tendered) < Number(p.amount) - 0.01);
  if (shortTender) {
    UI.toast(`Cash received (${UI.money(Number(shortTender.cash_tendered))}) is less than the cash part of this sale (${UI.money(Number(shortTender.amount))}). Enter the full amount handed over, or put the balance on another payment method.`, 'error', 7000);
    return;
  }

  const items = posCart.map((l) => ({
    product_id: l.product.id,
    unit_type: l.unitType,
    quantity: l.quantity,
    barcode_value: l.scannedBarcode || undefined,
    prescription: l.prescription || undefined,
    controlled_kyc: l.controlled_kyc || undefined,
  }));

  // BUG 95. Validated HERE as well as on the server for the same reason as the
  // short-tender check above: an offline sale is queued, and Offline.flush
  // treats a 4xx on replay as permanent and quarantines it. A cashier who
  // forgot to type the customer's name during a network drop would otherwise
  // lose the whole sale instead of being asked for one field.
  const owedTotal = posPayments.reduce((s, p) => s + (p.method === 'CASH' ? (Number(p.change_owed) || 0) : 0), 0);
  const changeName = (document.getElementById('pos-change-name').value || '').trim();
  const changePhone = (document.getElementById('pos-change-phone').value || '').trim();
  if (owedTotal > 0 && !changeName && !changePhone) {
    UI.toast('Enter the customer\'s name or phone number — it is the only way they can be paid back if they lose the claim slip.', 'error', 7000);
    return;
  }
  const overTender = posPayments.find(p => p.method === 'CASH' && Number(p.change_owed) > 0
    && Number(p.change_owed) > (Number(p.cash_tendered) || Number(p.amount)) - Number(p.amount) + 0.01);
  if (overTender) {
    UI.toast(`You cannot owe more change than the cash received leaves over. Check the cash tendered and the change owed.`, 'error', 7000);
    return;
  }

  const body = {
    branch_id: branchId,
    customer_id: posSelectedCustomer ? posSelectedCustomer.id : undefined,
    discount,
    items,
    payments: posPayments.map(p => ({ method: p.method, amount: Number(p.amount), cash_tendered: p.method === 'CASH' ? (Number(p.cash_tendered) || Number(p.amount)) : undefined, change_owed: p.method === 'CASH' && Number(p.change_owed) > 0 ? Number(p.change_owed) : undefined })),
    change_owed_for: owedTotal > 0 ? { name: changeName, phone: changePhone } : undefined,
    till_session_id: till ? till.id : undefined,
  };

  const checkoutBtn = document.getElementById('pos-checkout');
  checkoutBtn.disabled = true;
  try {
    const receipt = await Api.post('/sales', body);
    posCart = [];
    posPayments = [{ method: 'CASH', amount: 0, cash_tendered: '' }];
    posSelectedCustomer = null;
    clearPosCart(session.user.id, branchId);
    showReceipt(receipt);
    Router.navigate();
  } catch (e) {
    if (e.queued) {
      // The sale is safely in the offline queue, so the working cart has
      // served its purpose — clearing it prevents the same basket being
      // rung up twice when the cashier returns to the POS.
      posCart = [];
      posPayments = [{ method: 'CASH', amount: 0, cash_tendered: '' }];
      posSelectedCustomer = null;
      clearPosCart(session.user.id, branchId);
      UI.toast(e.message, 'warn', 6000);
      Router.navigate();
    } else {
      UI.toast(e.message, 'error', 6000);
      checkoutBtn.disabled = false;
    }
  }
}

function showReceipt(sale) {
  // The preview is the SAME renderer the printer uses (Receipt.build), so what
  // the cashier sees on screen is exactly what comes out of the printer —
  // previously the modal hand-rolled its own markup and could drift from any
  // printed copy.
  const modal = UI.openModal(`
    <h3>\u2713 Sale Completed</h3>
    <div class="receipt" id="receipt-preview">${Receipt.screenHtml(sale)}</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="receipt-print"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M6 16h12v5H6z"/></svg>Print Receipt</button>
      <button class="btn btn-secondary" id="receipt-a4"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/></svg>A4 / PDF</button>
      <button class="btn btn-primary" id="receipt-close">Close</button>
    </div>
  `);
  modal.querySelector('#receipt-print').addEventListener('click', () => Receipt.printThermal(sale));
  modal.querySelector('#receipt-a4').addEventListener('click', () => Receipt.printA4(sale));
  modal.querySelector('#receipt-close').addEventListener('click', () => UI.closeModal(modal));
}
// OWNER's read-only view of this deployment's plan limits/usage, as
// configured by the ADMIN (vendor) via the Admin Portal. Deliberately has
// NO editable fields here — the whole point of the hard-cap plan-limit
// model is that a client's own OWNER account can see exactly where they
// stand and who to contact, but can never change the numbers themselves
// (see the write-up below).
