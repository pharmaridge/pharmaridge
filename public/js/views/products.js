async function renderProducts(view) {
  if (!State.isManager()) {
    view.innerHTML = `<div class="card"><p>Only managers can manage the product catalog.</p></div>`;
    return;
  }
  const session = State.getSession();
  const branchId = State.effectiveBranchId();
  // catalogStats is a convenience banner; a failure here must never stop the
  // Products screen from rendering, so it degrades to null.
  const [products, branches, catalogStats] = await Promise.all([
    Api.get('/products'),
    Api.get('/branches'),
    Api.get('/catalog/stats').catch(() => null),
  ]);

  view.innerHTML = `
    <h2 class="page-title">Products</h2>
    <p class="page-subtitle">The master product catalog shared across every branch. Add a product here before receiving stock for it via Purchase Orders.</p>
    <div class="card">
      <h3>Add from the NAFDAC Approved List</h3>
      <p style="font-size:13px;color:var(--gray-600);margin-top:0;">
        ${catalogStats
          ? `Search <strong>${Number(catalogStats.total_products).toLocaleString()}</strong> NAFDAC-approved products
             covering <strong>${Number(catalogStats.total_ingredients).toLocaleString()}</strong> active ingredients, and pick one —`
          : 'Search the register of NAFDAC-approved products and pick one —'}
        the form below fills itself in (name, active ingredient, strength, NAFDAC number, dosage form, and whether
        it is prescription-only or a controlled drug). You can still edit anything afterwards, and anything not on
        the list can be typed in manually below.
      </p>
      <div class="form-row" style="position:relative;margin-bottom:0;">
        <label>Search by brand name, active ingredient, or NAFDAC number</label>
        <input id="cat-search" autocomplete="off" placeholder="Start typing… e.g. paracetamol, Panadol, or 04-1234" />
        <div id="cat-results" class="product-search-results hidden"></div>
      </div>
      <div style="margin-top:8px;">
        <button class="btn btn-secondary btn-sm" id="cat-browse">Browse by active ingredient</button>
      </div>
      <div id="cat-selected" class="hidden" style="margin-top:12px;"></div>
    </div>

    <div class="card">
      <h3>Add Product</h3>
      <p style="font-size:13px;color:var(--gray-600);margin-top:0;">
        Pre-filled when you pick from the approved list above — or fill it in yourself for any product
        that is not listed (a new registration, an imported item, or a non-drug shelf product).
      </p>
      <div class="form-inline">
        <div class="form-row"><label>Name</label><input id="p-name" placeholder="e.g. Panadol Extra" /></div>
        <div class="form-row"><label>Generic Name</label><input id="p-generic" placeholder="e.g. Paracetamol 500mg" /></div>
        <div class="form-row"><label>Category</label><input id="p-category" placeholder="e.g. Analgesic" /></div>
        <div class="form-row"><label>NAFDAC Reg. No.</label><input id="p-nafdac" /></div>
        <div class="form-row">
          <label>Dispensing Type</label>
          <select id="p-dispensing">
            <option value="OTC">OTC (over the counter)</option>
            <option value="POM">POM (prescription-only)</option>
          </select>
        </div>
        <div class="form-row">
          <label>Controlled Substance?</label>
          <select id="p-controlled"><option value="0">No</option><option value="1">Yes (e.g. Tramadol, Codeine)</option></select>
        </div>
        <div class="form-row"><label>Base Unit</label><input id="p-base-unit" placeholder="e.g. tablet, capsule, bottle" value="tablet" /></div>
        <div class="form-row"><label>Units per Pack</label><input type="number" id="p-units-per-pack" min="1" step="1" value="1" /></div>
        <div class="form-row"><label>Packs per Carton (optional)</label><input type="number" id="p-packs-per-carton" min="1" step="1" /></div>
        <div class="form-row"><label>Reorder Level</label><input type="number" id="p-reorder" min="0" step="1" value="0" /></div>
      </div>
      <button class="btn btn-primary" id="p-add" style="margin-top:10px;">Add Product</button>
    </div>
    <div class="card">
      <h3>Catalog</h3>
      ${Exporter.toolbar('products', { label: 'the product catalogue' })}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Generic Name</th><th>Category</th><th>Type</th><th>Controlled</th><th>Base Unit</th><th>Per Pack</th><th>Per Carton</th><th>Reorder Level</th><th></th></tr></thead>
          <tbody>
            ${products.map(p => `
              <tr>
                <td>${UI.escapeHtml(p.name)}</td>
                <td>${UI.escapeHtml(p.generic_name || '—')}</td>
                <td>${UI.escapeHtml(p.category || '—')}</td>
                <td>${UI.badge(p.dispensing_type, p.dispensing_type === 'POM' ? 'amber' : 'gray')}</td>
                <td>${p.is_controlled ? UI.badge('Controlled', 'red') : '—'}</td>
                <td>${UI.escapeHtml(p.base_unit)}</td>
                <td>${p.units_per_pack}</td>
                <td>${p.packs_per_carton == null ? '—' : p.packs_per_carton}</td>
                <td>${p.reorder_level}</td>
                <td>
                  <button class="btn btn-secondary btn-sm" data-edit-product="${p.id}">Edit</button>
                  <button class="btn btn-secondary btn-sm" data-price-product="${p.id}" data-name="${UI.escapeHtml(p.name)}">Branch Prices</button>
                  <button class="btn btn-danger btn-sm" data-delete-product="${p.id}" data-name="${UI.escapeHtml(p.name)}">Delete</button>
                </td>
              </tr>
            `).join('') || `<tr><td colspan="10" class="empty-state">No products yet — add your first one above</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  Exporter.wireTableReport('products', {
    title: 'Product Catalogue',
    subtitle: 'Master product list (all branches)',
    filename: 'product-catalogue',
    columns: [
      { key: 'name', label: 'Product' },
      { key: 'generic_name', label: 'Generic / Active Ingredient' },
      { key: 'category', label: 'Category' },
      { key: 'nafdac_reg_no', label: 'NAFDAC No.' },
      { key: 'dispensing_type', label: 'Type' },
      { key: 'is_controlled', label: 'Controlled', format: (v) => (v ? 'YES' : '') },
      { key: 'base_unit', label: 'Base Unit' },
      { key: 'units_per_pack', label: 'Units/Pack', align: 'right' },
      { key: 'packs_per_carton', label: 'Packs/Carton', align: 'right' },
      { key: 'reorder_level', label: 'Reorder Level', align: 'right' },
    ],
    rows: products,
    summary: [
      { label: 'Products', value: String(products.length) },
      { label: 'Prescription-only', value: String(products.filter((p) => p.dispensing_type === 'POM').length) },
      { label: 'Controlled', value: String(products.filter((p) => p.is_controlled).length) },
    ],
    emptyMessage: 'No products in the catalogue yet.',
  });

  wireCatalogSearch();

  UI.guardedClick(document.getElementById('p-add'), async () => {
    const name = document.getElementById('p-name').value.trim();
    if (!name) { UI.toast('Name is required', 'error'); return; }
    const unitsPerPack = Number(document.getElementById('p-units-per-pack').value) || 1;
    const packsPerCartonRaw = document.getElementById('p-packs-per-carton').value;
    const reorderLevel = Number(document.getElementById('p-reorder').value) || 0;
    try {
      await Api.post('/products', {
        name,
        generic_name: document.getElementById('p-generic').value.trim() || undefined,
        category: document.getElementById('p-category').value.trim() || undefined,
        nafdac_reg_no: document.getElementById('p-nafdac').value.trim() || undefined,
        dispensing_type: document.getElementById('p-dispensing').value,
        is_controlled: document.getElementById('p-controlled').value === '1',
        base_unit: document.getElementById('p-base-unit').value.trim() || 'tablet',
        units_per_pack: unitsPerPack,
        packs_per_carton: packsPerCartonRaw ? Number(packsPerCartonRaw) : undefined,
        reorder_level: reorderLevel,
        // Provenance: set only when this product came from the NAFDAC list.
        // Left undefined for a manually-typed product, which the backend
        // accepts as a first-class case.
        nafdac_catalog_id: selectedCatalogId || undefined,
      }, { allowOfflineQueue: false });
      UI.toast('Product added', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });

  view.querySelectorAll('[data-edit-product]').forEach((btn) => btn.addEventListener('click', () => {
    const p = products.find((x) => x.id === btn.dataset.editProduct);
    openEditProductModal(p);
  }));

  view.querySelectorAll('[data-price-product]').forEach((btn) => btn.addEventListener('click', () => {
    openPriceOverrideModal(btn.dataset.priceProduct, btn.dataset.name, branches);
  }));

  view.querySelectorAll('[data-delete-product]').forEach((btn) => UI.guardedClick(btn, async () => {
    // FUNCTIONAL/DATA-INTEGRITY FIX (found during a production audit): this
    // confirmation message previously said "will no longer be sellable or
    // receivable" — but "no longer sellable" was never actually enforced
    // consistently: existing, already-paid-for shelf stock of a discontinued
    // product could never be sold again (permanently stranding its value),
    // which contradicts the "Existing stock batches... are preserved" promise
    // in the same sentence. Reworded to accurately describe the now-correct,
    // real-world pharmacy behavior: existing stock remains fully sellable
    // until it runs out; only NEW purchase orders for the discontinued product
    // are blocked (see the write-up below salesService.js's createSale and the
    // original implementation purchaseOrders.js for the backend enforcement
    // this now accurately describes).
    if (!confirm(`Discontinue "${btn.dataset.name}"? Existing stock already on the shelf remains fully sellable until it runs out, and sales history is preserved — but no NEW purchase order can ever be placed for it again.`)) return;
    try {
      await Api.del(`/products/${btn.dataset.deleteProduct}`);
      UI.toast('Product removed', 'success');
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  }));
}

// ---------------------------------------------------------------------------
// NAFDAC approved-list autocomplete
// ---------------------------------------------------------------------------

// Module-scope so the "Add Product" handler can read it, and so re-entering
// the view via the router resets it (wireCatalogSearch clears it on every
// render — a stale id from a previous visit must never be attached to a new,
// manually-typed product).
let selectedCatalogId = null;

function wireCatalogSearch() {
  selectedCatalogId = null;

  const input = document.getElementById('cat-search');
  const resultsEl = document.getElementById('cat-results');
  const selectedEl = document.getElementById('cat-selected');
  if (!input || !resultsEl) return;

  let debounceTimer = null;
  // Monotonic request id. Autocomplete fires many overlapping requests and
  // they can resolve OUT OF ORDER — a slow "para" response landing after a
  // fast "paracetamol" one would repaint the list with stale results while
  // the user is looking at the right ones. Only the newest request may paint.
  let latestRequest = 0;

  function hide() { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; }

  async function search(term) {
    const mine = ++latestRequest;
    try {
      const rows = await Api.get(`/catalog?q=${encodeURIComponent(term)}&limit=20`);
      if (mine !== latestRequest) return; // a newer keystroke already won
      if (!rows.length) {
        resultsEl.innerHTML = `<div class="product-search-item"><span class="meta">
          No approved product matches “${UI.escapeHtml(term)}”. You can still add it manually in the form below.
        </span></div>`;
        resultsEl.classList.remove('hidden');
        return;
      }
      resultsEl.innerHTML = rows.map((r) => `
        <div class="product-search-item" data-cat-id="${r.id}">
          <div>
            <div><strong>${UI.escapeHtml(r.product_name)}</strong>
              ${r.is_controlled ? UI.badge('Controlled', 'red') : ''}
              ${r.dispensing_type === 'POM' ? UI.badge('POM', 'amber') : ''}
            </div>
            <div class="meta">
              ${UI.escapeHtml(r.ingredient_name || '—')}${r.strength ? ' · ' + UI.escapeHtml(r.strength) : ''}${r.dosage_form ? ' · ' + UI.escapeHtml(r.dosage_form) : ''}
            </div>
            <div class="meta">${UI.escapeHtml(r.manufacturer || '')}${r.nafdac_reg_no ? ' · NAFDAC ' + UI.escapeHtml(r.nafdac_reg_no) : ''}</div>
          </div>
        </div>`).join('');
      resultsEl.classList.remove('hidden');
      resultsEl.querySelectorAll('[data-cat-id]').forEach((el) => {
        el.addEventListener('click', () => pick(el.dataset.catId));
      });
    } catch (e) {
      if (mine !== latestRequest) return;
      UI.toast(e.message, 'error');
    }
  }

  async function pick(id) {
    hide();
    let entry;
    try {
      entry = await Api.get(`/catalog/${id}`);
    } catch (e) { UI.toast(e.message, 'error'); return; }

    // Guard against the single most common data-entry mistake: adding the same
    // product twice under slightly different spellings. The backend tells us
    // whether this catalog row is already in the client's inventory.
    if (entry.already_in_inventory) {
      selectedEl.className = 'card';
      selectedEl.style.borderLeft = '4px solid var(--amber-500)';
      selectedEl.innerHTML = `
        <p style="margin:0;"><strong>Already in your inventory</strong> as
        “${UI.escapeHtml(entry.already_in_inventory.name)}”. Adding it again would split its stock across
        two products. Edit the existing one instead, or clear this and continue if it really is different.</p>
        <button class="btn btn-secondary btn-sm" id="cat-clear" style="margin-top:8px;">Clear</button>`;
      selectedEl.classList.remove('hidden');
      document.getElementById('cat-clear').addEventListener('click', clearSelection);
      selectedCatalogId = null;
      return;
    }

    selectedCatalogId = entry.id;

    // Pre-fill the manual form. Everything remains editable — these are
    // sensible defaults from the register, not locked values.
    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val == null ? '' : val; };
    set('p-name', entry.product_name);
    // Generic name = active ingredient + strength, which is exactly what a
    // pharmacist means by the generic of a branded product.
    set('p-generic', [entry.ingredient_name, entry.strength].filter(Boolean).join(' '));
    set('p-category', entry.category);
    set('p-nafdac', entry.nafdac_reg_no);
    set('p-base-unit', entry.base_unit || 'tablet');
    const disp = document.getElementById('p-dispensing');
    if (disp) disp.value = entry.dispensing_type || 'OTC';
    const ctrl = document.getElementById('p-controlled');
    if (ctrl) ctrl.value = entry.is_controlled ? '1' : '0';

    // Show what was chosen, why it was classified that way, and the
    // therapeutic alternatives sharing its active ingredient.
    selectedEl.className = 'card';
    selectedEl.style.borderLeft = '4px solid var(--green-600)';
    selectedEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
        <div>
          <p style="margin:0;"><strong>${UI.escapeHtml(entry.product_name)}</strong>
            ${entry.is_controlled ? UI.badge('Controlled drug', 'red') : ''}
            ${entry.dispensing_type === 'POM' ? UI.badge('Prescription-only', 'amber') : UI.badge('OTC', 'gray')}
          </p>
          <p class="meta" style="margin:4px 0 0;font-size:12px;color:var(--gray-600);">
            ${UI.escapeHtml(entry.ingredient_name || '—')}${entry.strength ? ' · ' + UI.escapeHtml(entry.strength) : ''}${entry.dosage_form ? ' · ' + UI.escapeHtml(entry.dosage_form) : ''}<br/>
            ${UI.escapeHtml(entry.manufacturer || '')}${entry.pack_size ? ' · pack: ' + UI.escapeHtml(entry.pack_size) : ''}<br/>
            NAFDAC ${UI.escapeHtml(entry.nafdac_reg_no || '—')}${entry.registration_expiry ? ' · registration expires ' + UI.escapeHtml(entry.registration_expiry) : ''}
          </p>
          <p style="margin:8px 0 0;font-size:12px;color:var(--gray-600);">
            The form below has been filled in. Set your own pack sizes and reorder level, then press <strong>Add Product</strong>.
          </p>
        </div>
        <button class="btn btn-secondary btn-sm" id="cat-clear">Clear</button>
      </div>
      <div id="cat-alternatives" style="margin-top:10px;"></div>`;
    selectedEl.classList.remove('hidden');
    document.getElementById('cat-clear').addEventListener('click', clearSelection);

    loadAlternatives(entry);
  }

  async function loadAlternatives(entry) {
    const box = document.getElementById('cat-alternatives');
    if (!box || !entry.ingredient_key) return;
    try {
      const alts = await Api.get(`/catalog/alternatives?ingredient_key=${encodeURIComponent(entry.ingredient_key)}&exclude_id=${entry.id}&limit=8`);
      if (!alts.length) return;
      box.innerHTML = `
        <details>
          <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--green-700);">
            ${alts.length} other approved product${alts.length === 1 ? '' : 's'} with the same active ingredient
          </summary>
          <div class="meta" style="font-size:12px;color:var(--gray-600);margin:6px 0;">
            Same active ingredient — useful when a brand is out of stock. Click one to switch to it.
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Product</th><th>Strength</th><th>Form</th><th>Manufacturer</th><th></th></tr></thead>
              <tbody>
                ${alts.map((a) => `
                  <tr>
                    <td>${UI.escapeHtml(a.product_name)}</td>
                    <td>${UI.escapeHtml(a.strength || '—')}</td>
                    <td>${UI.escapeHtml(a.dosage_form || '—')}</td>
                    <td>${UI.escapeHtml(a.manufacturer || '—')}</td>
                    <td><button class="btn btn-secondary btn-sm" data-alt-id="${a.id}">Use this</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>`;
      box.querySelectorAll('[data-alt-id]').forEach((b) => {
        b.addEventListener('click', () => pick(b.dataset.altId));
      });
    } catch (e) { /* alternatives are a convenience; never block the main flow */ }
  }

  function clearSelection() {
    selectedCatalogId = null;
    selectedEl.classList.add('hidden');
    selectedEl.innerHTML = '';
    selectedEl.removeAttribute('style');
    input.value = '';
    hide();
  }

  // Ingredient-first browse. A pharmacist often thinks "what amoxicillin do we
  // have?" before thinking of any brand, so this exposes the grouped-ingredient
  // endpoint rather than forcing brand-name-first search.
  const browseBtn = document.getElementById('cat-browse');
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      const modal = UI.openModal(`
        <h3>Browse by Active Ingredient</h3>
        <div class="form-row">
          <label>Filter ingredients</label>
          <input id="ing-filter" autocomplete="off" placeholder="e.g. amox, paracetamol" />
        </div>
        <div id="ing-list" class="table-wrap" style="max-height:340px;overflow-y:auto;"></div>
        <div class="modal-actions"><button class="btn btn-secondary" id="ing-close">Close</button></div>
      `);
      modal.querySelector('#ing-close').addEventListener('click', () => UI.closeModal(modal));
      const listEl = modal.querySelector('#ing-list');
      const filterEl = modal.querySelector('#ing-filter');

      let ingTimer = null;
      let ingRequest = 0;
      async function loadIngredients(term) {
        const mine = ++ingRequest;
        try {
          const rows = await Api.get(`/catalog/ingredients?q=${encodeURIComponent(term || '')}&limit=40`);
          if (mine !== ingRequest) return;
          listEl.innerHTML = rows.length ? `
            <table>
              <thead><tr><th>Active Ingredient</th><th>Approved Products</th><th></th></tr></thead>
              <tbody>
                ${rows.map((r) => `
                  <tr>
                    <td>${UI.escapeHtml(r.ingredient_name || r.ingredient_key)}</td>
                    <td>${r.product_count}</td>
                    <td><button class="btn btn-secondary btn-sm" data-ing="${UI.escapeHtml(r.ingredient_name || r.ingredient_key)}">Search these</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>` : `<p class="empty-state">No ingredient matches that filter.</p>`;
          listEl.querySelectorAll('[data-ing]').forEach((b) => b.addEventListener('click', () => {
            UI.closeModal(modal);
            input.value = b.dataset.ing;
            search(b.dataset.ing);
            input.focus();
          }));
        } catch (e) { UI.toast(e.message, 'error'); }
      }
      filterEl.addEventListener('input', () => {
        clearTimeout(ingTimer);
        ingTimer = setTimeout(() => loadIngredients(filterEl.value.trim()), 250);
      });
      loadIngredients('');
    });
  }

  input.addEventListener('input', () => {
    const term = input.value.trim();
    clearTimeout(debounceTimer);
    if (term.length < 2) { hide(); return; }
    // 250ms debounce: fast enough to feel instant, slow enough that typing
    // "paracetamol" costs one request instead of eleven. On the Workers free
    // plan every request counts against the daily quota, and branches share it.
    debounceTimer = setTimeout(() => search(term), 250);
  });

  // Close the dropdown when clicking away. Registered through Router.onCleanup
  // so it is removed on navigation — otherwise every visit to this screen
  // would leak another document-level listener (see router.js's contract).
  const onDocClick = (e) => {
    if (!resultsEl.contains(e.target) && e.target !== input) hide();
  };
  document.addEventListener('click', onDocClick);
  if (window.Router && Router.onCleanup) {
    Router.onCleanup(() => {
      document.removeEventListener('click', onDocClick);
      clearTimeout(debounceTimer);
    });
  }
}

function openEditProductModal(p) {
  const modal = UI.openModal(`
    <h3>Edit Product — ${UI.escapeHtml(p.name)}</h3>
    <div class="form-row"><label>Name</label><input id="ep-name" value="${UI.escapeHtml(p.name)}" /></div>
    <div class="form-row"><label>Generic Name</label><input id="ep-generic" value="${UI.escapeHtml(p.generic_name || '')}" /></div>
    <div class="form-row"><label>Category</label><input id="ep-category" value="${UI.escapeHtml(p.category || '')}" /></div>
    <div class="form-row"><label>NAFDAC Reg. No.</label><input id="ep-nafdac" value="${UI.escapeHtml(p.nafdac_reg_no || '')}" /></div>
    <div class="form-row">
      <label>Dispensing Type</label>
      <select id="ep-dispensing">
        <option value="OTC" ${p.dispensing_type === 'OTC' ? 'selected' : ''}>OTC (over the counter)</option>
        <option value="POM" ${p.dispensing_type === 'POM' ? 'selected' : ''}>POM (prescription-only)</option>
      </select>
    </div>
    <div class="form-row">
      <label>Controlled Substance?</label>
      <select id="ep-controlled">
        <option value="0" ${!p.is_controlled ? 'selected' : ''}>No</option>
        <option value="1" ${p.is_controlled ? 'selected' : ''}>Yes (e.g. Tramadol, Codeine)</option>
      </select>
    </div>
    <div class="form-row"><label>Base Unit</label><input id="ep-base-unit" value="${UI.escapeHtml(p.base_unit)}" /></div>
    <div class="form-row"><label>Units per Pack</label><input type="number" id="ep-units-per-pack" min="1" step="1" value="${p.units_per_pack}" /></div>
    <div class="form-row"><label>Packs per Carton (optional)</label><input type="number" id="ep-packs-per-carton" min="1" step="1" value="${p.packs_per_carton == null ? '' : p.packs_per_carton}" /></div>
    <div class="form-row"><label>Reorder Level</label><input type="number" id="ep-reorder" min="0" step="1" value="${p.reorder_level}" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="ep-cancel">Cancel</button>
      <button class="btn btn-primary" id="ep-save">Save</button>
    </div>
  `);
  modal.querySelector('#ep-cancel').addEventListener('click', () => UI.closeModal(modal));
  UI.guardedClick(modal.querySelector('#ep-save'), async () => {
    const name = modal.querySelector('#ep-name').value.trim();
    if (!name) { UI.toast('Name is required', 'error'); return; }
    const packsPerCartonRaw = modal.querySelector('#ep-packs-per-carton').value;
    try {
      await Api.put(`/products/${p.id}`, {
        name,
        generic_name: modal.querySelector('#ep-generic').value.trim() || null,
        category: modal.querySelector('#ep-category').value.trim() || null,
        nafdac_reg_no: modal.querySelector('#ep-nafdac').value.trim() || null,
        dispensing_type: modal.querySelector('#ep-dispensing').value,
        is_controlled: modal.querySelector('#ep-controlled').value === '1',
        base_unit: modal.querySelector('#ep-base-unit').value.trim() || 'tablet',
        units_per_pack: Number(modal.querySelector('#ep-units-per-pack').value) || 1,
        packs_per_carton: packsPerCartonRaw ? Number(packsPerCartonRaw) : null,
        reorder_level: Number(modal.querySelector('#ep-reorder').value) || 0,
      }, { allowOfflineQueue: false });
      UI.toast('Product updated', 'success');
      UI.closeModal(modal);
      Router.navigate();
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}

function openPriceOverrideModal(productId, productName, branches) {
  const modal = UI.openModal(`
    <h3>Branch Default Prices — ${UI.escapeHtml(productName)}</h3>
    <p style="font-size:12px;color:var(--gray-600);margin-bottom:10px;">
      Sets this branch's default selling price, only used to PRE-FILL the price when that branch next receives a new stock batch of this product via Purchase Orders — it does not change the price of stock already on the shelf (that lives on the batch itself).
    </p>
    <div class="form-row">
      <label>Branch</label>
      <select id="po-branch">${branches.map((b) => `<option value="${b.id}">${UI.escapeHtml(b.name)}</option>`).join('')}</select>
    </div>
    <div class="form-row"><label>Default Selling Price (per base unit)</label><input type="number" id="po-price" min="0" step="0.01" /></div>
    <div class="form-row"><label>Pack Price (optional)</label><input type="number" id="po-pack-price" min="0" step="0.01" /></div>
    <div class="form-row"><label>Carton Price (optional)</label><input type="number" id="po-carton-price" min="0" step="0.01" /></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="po-cancel">Cancel</button>
      <button class="btn btn-primary" id="po-save">Save</button>
    </div>
  `);
  modal.querySelector('#po-cancel').addEventListener('click', () => UI.closeModal(modal));

  // FUNCTIONAL GAP CLOSED (found during a production audit — "does the
  // frontend use 100% of what the backend supports?"): the backend's
  // GET /api/products/:id has always returned this product's full
  // `price_overrides` array (one row per branch that has ever had a
  // default price set for it), but this modal previously never called
  // it — the price/pack-price/carton-price fields always opened BLANK
  // regardless of what was already configured for the selected branch,
  // and switching the branch dropdown never updated them either. A
  // manager reviewing or correcting an existing branch price had no
  // way to see the current value before overwriting it, and had to
  // remember (or separately look up) whatever was already set. Fixed
  // by fetching the product's overrides once when the modal opens and
  // re-populating the three price fields whenever the branch selection
  // changes, defaulting to blank only for a branch that genuinely has
  // no override yet.
  let overridesByBranch = new Map();
  function fillFieldsForBranch(branchId) {
    const existing = overridesByBranch.get(branchId);
    modal.querySelector('#po-price').value = existing ? existing.default_selling_price : '';
    modal.querySelector('#po-pack-price').value = existing && existing.pack_price != null ? existing.pack_price : '';
    modal.querySelector('#po-carton-price').value = existing && existing.carton_price != null ? existing.carton_price : '';
  }
  Api.get(`/products/${productId}`).then((full) => {
    overridesByBranch = new Map((full.price_overrides || []).map((o) => [o.branch_id, o]));
    fillFieldsForBranch(modal.querySelector('#po-branch').value);
  }).catch(() => { /* if this lookup fails, the fields simply stay blank — not a fatal error for the modal itself */ });
  modal.querySelector('#po-branch').addEventListener('change', (e) => fillFieldsForBranch(e.target.value));

  UI.guardedClick(modal.querySelector('#po-save'), async () => {
    const branchId = modal.querySelector('#po-branch').value;
    const price = Number(modal.querySelector('#po-price').value);
    if (!Number.isFinite(price) || price < 0) { UI.toast('Enter a valid non-negative selling price', 'error'); return; }
    const packPriceRaw = modal.querySelector('#po-pack-price').value;
    const cartonPriceRaw = modal.querySelector('#po-carton-price').value;
    try {
      await Api.put(`/products/${productId}/price-override/${branchId}`, {
        default_selling_price: price,
        pack_price: packPriceRaw ? Number(packPriceRaw) : undefined,
        carton_price: cartonPriceRaw ? Number(cartonPriceRaw) : undefined,
      }, { allowOfflineQueue: false });
      UI.toast('Branch price saved', 'success');
      UI.closeModal(modal);
    } catch (e) { UI.toast(e.message, 'error'); }
  });
}
// Point of Sale view. Cart state lives at module scope so it survives
// across the async product/customer lookups triggered mid-sale, but is
// reset whenever this view is (re)entered fresh via the router.
let posCart = [];
let posPayments = [];
let posSelectedCustomer = null;
let posRerenderCart = null; // set by renderPos(); lets addProductToCart refresh the cart without a full view reload

// ---- IN-PROGRESS CART PERSISTENCE ------------------------------------
//
// Added after an audit found the working cart was a plain in-memory
// array: a session expiry, an accidental refresh, a browser crash or a
// dead battery meant re-scanning every item in front of a waiting
// customer. On a 12-hour hard token expiry (see the sliding-session note
// in worker/src/lib/auth.js) that was a routine daily event, not an edge
// case.
//
// SCOPED PER USER **AND** BRANCH. Pharmacy terminals are shared: without
// scoping, cashier B returning to the POS would silently inherit cashier
// A's half-built basket and could sell it under their own name. The key
// includes both ids so a restored cart can only ever belong to the
// person and branch that built it.
//
// localStorage (not IndexedDB) deliberately: this must be readable
// SYNCHRONOUSLY during the first paint of renderPos(), before any await,
// so the cart is simply there rather than flickering in a moment later.
// A cart is a handful of lines, far inside the 5MB budget.
const POS_CART_KEY_PREFIX = 'gl_pms_pos_cart:';

function posCartKey(userId, branchId) {
  return `${POS_CART_KEY_PREFIX}${userId || 'anon'}:${branchId || 'none'}`;
}

function savePosCart(userId, branchId) {
  try {
    const key = posCartKey(userId, branchId);
    // An empty cart is REMOVED rather than stored, so a finished sale
    // never leaves a stale marker for the next cashier to restore.
    if (!posCart.length) { localStorage.removeItem(key); return; }
    localStorage.setItem(key, JSON.stringify({
      cart: posCart,
      customer: posSelectedCustomer,
      savedAt: new Date().toISOString(),
    }));
  } catch (e) { /* quota/private-mode — never break a sale over this */ }
}

function loadPosCart(userId, branchId) {
  try {
    const raw = localStorage.getItem(posCartKey(userId, branchId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cart) || !parsed.cart.length) return null;
    // Prices, stock and expiry all move. Restoring a basket built days
    // ago would quote figures that are no longer true, so anything older
    // than one trading day is discarded rather than shown.
    const ageMs = Date.now() - Date.parse(parsed.savedAt || 0);
    if (!Number.isFinite(ageMs) || ageMs > 12 * 60 * 60 * 1000) {
      localStorage.removeItem(posCartKey(userId, branchId));
      return null;
    }
    return parsed;
  } catch (e) { return null; }
}

function clearPosCart(userId, branchId) {
  try { localStorage.removeItem(posCartKey(userId, branchId)); } catch (e) { /* ignore */ }
}

