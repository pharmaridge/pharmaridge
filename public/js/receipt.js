// Customer receipt rendering — the single most-printed document in the system.
//
// Produces two formats from one data source, so a reprint can never disagree
// with the original:
//   - THERMAL: 80mm roll, the pharmacy counter printer.
//   - A4:      a full-page tax-invoice style copy, for a customer who needs a
//              filed document (company/insurance reimbursement) or when the
//              branch has no thermal printer.
//
// Both go through Exporter.printDocument(), so "Save as PDF" is available from
// the same dialog on desktop, Android and iOS.
const Receipt = (() => {
  const esc = (s) => Exporter.escapeHtml(s);

  function money(n) { return UI.money(n); }

  function header(sale, { thermal }) {
    const b = (window.Branding && Branding.get && Branding.get()) || {};
    const name = (window.Branding && Branding.displayName && Branding.displayName()) || 'PharmaRidge';
    const branchName = sale.branch_name || '';
    if (thermal) {
      return `
        <div class="r-center">
          ${b.has_logo ? `<img src="/api/branding/logo" alt="" class="r-logo"/><br/>` : ''}
          <div class="r-business">${esc(name)}</div>
          <!-- CLIENT INSTRUCTION: the PHARMACY's name is the bold header, and
               "Powered by PharmaRidge" sits subtle directly beneath it. The
               customer's receipt belongs to the shop they bought from; the
               software is the small print. Uses printAttribution() rather
               than poweredByLine() so it appears even before the client has
               set a trading name — see the note in js/branding.js. -->
          <div class="r-poweredby">${esc((window.Branding && Branding.printAttribution && Branding.printAttribution()) || '')}</div>
          ${branchName ? `<div class="r-small">${esc(branchName)}</div>` : ''}
          ${sale.branch_address ? `<div class="r-small">${esc(sale.branch_address)}</div>` : ''}
          ${sale.branch_phone ? `<div class="r-small">Tel: ${esc(sale.branch_phone)}</div>` : ''}
          ${sale.pcn_license_no ? `<div class="r-small">PCN: ${esc(sale.pcn_license_no)}</div>` : ''}
        </div>
        <div class="r-rule"></div>`;
    }
    return Exporter.documentHeader('SALES RECEIPT', branchName);
  }

  // Line items, totals, payments — identical figures in both layouts.
  function bodyLines(sale, { thermal }) {
    const L = (l, r, cls = '') => thermal
      ? `<div class="r-line ${cls}"><span>${l}</span><span>${r}</span></div>`
      : `<tr class="${cls}"><td>${l}</td><td style="text-align:right">${r}</td></tr>`;

    const items = sale.items.map((i) => {
      const unit = i.unit_type && i.unit_type !== 'BASE_UNIT' ? ` (${esc(i.unit_type)})` : '';
      const label = `${esc(i.product_name)} x${i.quantity}${unit}`;
      return thermal
        ? `<div class="r-line"><span>${label}</span><span>${money(i.line_total)}</span></div>
           <div class="r-small" style="margin-left:6px;color:#333;">@ ${money(i.unit_price)}${i.batch_no ? ` · batch ${esc(i.batch_no)}` : ''}</div>`
        : `<tr><td>${esc(i.product_name)}${unit}</td><td style="text-align:right">${i.quantity}</td>
             <td style="text-align:right">${money(i.unit_price)}</td>
             <td style="text-align:right">${money(i.line_total)}</td></tr>`;
    }).join('');

    const totals = [
      L('Subtotal', money(sale.subtotal)),
      Number(sale.discount) > 0 ? L('Discount', `-${money(sale.discount)}`) : '',
      L('<b>TOTAL</b>', `<b>${money(sale.total)}</b>`, 'r-total'),
      Number(sale.vat_amount) > 0 ? L('(includes VAT)', money(sale.vat_amount), 'r-small') : '',
    ].join('');

    const payments = sale.payments.map((p) =>
      L(esc(p.method) + (Number(p.change_given) > 0 ? ' (tendered)' : ''),
        money(Number(p.change_given) > 0 ? p.cash_tendered || p.amount : p.amount))
      + (Number(p.change_given) > 0 ? L('Change', money(p.change_given)) : '')
    ).join('');

    // BUG 95 — CHANGE OWED. The client asked for the claim to appear on the
    // ORIGINAL purchase receipt, not only on a separate slip: the piece of
    // paper the customer walks out with must be the one that proves the debt.
    // Rendered big and last so it survives a hurried glance at a thermal roll.
    const owedClaims = Array.isArray(sale.change_owed) ? sale.change_owed : [];
    const owedBlock = owedClaims.length ? owedClaims.map((c) => (thermal
      ? `<div class="r-rule"></div>`
        + L('<b>CHANGE OWED TO YOU</b>', `<b>${money(c.amount)}</b>`, 'r-total')
        + L('Claim code', `<b>${esc(c.claim_code)}</b>`)
        + (c.customer_name ? L('For', esc(c.customer_name)) : '')
        + L('<span class="r-small">Keep this. Bring the code (or your name/phone) to collect your change or use it on your next purchase.</span>', '', 'r-small')
      : `<table class="print-summary"><tbody>
          ${L('<b>CHANGE OWED TO YOU</b>', `<b>${money(c.amount)}</b>`, 'r-total')}
          ${L('Claim code', `<b>${esc(c.claim_code)}</b>`)}
          ${c.customer_name ? L('For', esc(c.customer_name)) : ''}
          ${L('<span class="r-small">Keep this receipt. Bring the code — or your name / phone number — to collect your change, or use it against your next purchase.</span>', '', 'r-small')}
        </tbody></table>`)).join('') : '';

    if (thermal) {
      return `${items}<div class="r-rule"></div>${totals}<div class="r-rule"></div>${payments}${owedBlock}`;
    }
    return `
      <table class="print-table">
        <thead><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <table class="print-summary"><tbody>${totals}${payments}</tbody></table>
      ${owedBlock}`;
  }

  // Regulated content. A dispensed prescription-only or controlled medicine
  // must leave an auditable paper trail; these blocks are what a PCN inspector
  // expects to see on the customer's copy.
  function complianceBlock(sale, { thermal }) {
    let out = '';
    if (sale.prescriptions && sale.prescriptions.length) {
      const rows = sale.prescriptions.map((p) => thermal
        ? `<div class="r-small">Rx: ${esc(p.prescriber_name || '—')}${p.prescriber_pcn_or_mdcn_no ? ` (${esc(p.prescriber_pcn_or_mdcn_no)})` : ''}<br/>
             Patient: ${esc(p.patient_name || '—')}${p.dosage_notes ? `<br/>Dosage: ${esc(p.dosage_notes)}` : ''}</div>`
        : `<tr><td>${esc(p.prescriber_name || '—')}</td><td>${esc(p.prescriber_pcn_or_mdcn_no || '—')}</td>
             <td>${esc(p.patient_name || '—')}</td><td>${esc(p.dosage_notes || '—')}</td></tr>`).join('');
      out += thermal
        ? `<div class="r-rule"></div><div class="r-small"><b>PRESCRIPTION RECORD</b></div>${rows}`
        : `<div class="print-section"><h3>Prescription Record</h3>
             <table class="print-table"><thead><tr><th>Prescriber</th><th>PCN/MDCN No.</th><th>Patient</th><th>Dosage</th></tr></thead>
             <tbody>${rows}</tbody></table></div>`;
    }
    if (sale.controlled_entries && sale.controlled_entries.length) {
      const rows = sale.controlled_entries.map((e) => thermal
        ? `<div class="r-small">${esc(e.product_name || '')} x${e.quantity_dispensed} — ${esc(e.buyer_name || '')}
             ${e.buyer_id_type ? `<br/>ID: ${esc(e.buyer_id_type)} ${esc(e.buyer_id_number || '')}` : ''}</div>`
        : `<tr><td>${esc(e.product_name || '—')}</td><td style="text-align:right">${e.quantity_dispensed}</td>
             <td>${esc(e.buyer_name || '—')}</td><td>${esc(e.buyer_phone || '—')}</td>
             <td>${esc(e.buyer_id_type || '—')} ${esc(e.buyer_id_number || '')}</td></tr>`).join('');
      out += thermal
        ? `<div class="r-rule"></div><div class="r-small"><b>CONTROLLED SUBSTANCE</b></div>${rows}`
        : `<div class="print-section"><h3>Controlled Substance Register Entry</h3>
             <table class="print-table"><thead><tr><th>Product</th><th style="text-align:right">Qty</th><th>Buyer</th><th>Phone</th><th>ID</th></tr></thead>
             <tbody>${rows}</tbody></table></div>`;
    }
    return out;
  }

  function build(sale, { thermal }) {
    const voided = sale.status === 'VOIDED';
    const meta = thermal
      ? `<div class="r-small">
           Receipt: ${esc(String(sale.id).slice(0, 8).toUpperCase())}<br/>
           Date: ${esc(UI.shortDate(sale.created_at))}<br/>
           ${sale.served_by_name ? `Served by: ${esc(sale.served_by_name)}<br/>` : ''}
           ${sale.customer_name ? `Customer: ${esc(sale.customer_name)}<br/>` : ''}
         </div><div class="r-rule"></div>`
      : `<table class="print-summary" style="margin:0 0 10px 0;"><tbody>
           <tr><th>Receipt No.</th><td>${esc(String(sale.id).slice(0, 8).toUpperCase())}</td></tr>
           <tr><th>Date</th><td>${esc(UI.shortDate(sale.created_at))}</td></tr>
           ${sale.served_by_name ? `<tr><th>Served by</th><td>${esc(sale.served_by_name)}</td></tr>` : ''}
           ${sale.customer_name ? `<tr><th>Customer</th><td>${esc(sale.customer_name)}</td></tr>` : ''}
         </tbody></table>`;

    // A voided sale must never be mistakable for a valid one, on paper least
    // of all — a printed copy outlives the screen it came from.
    const voidBanner = voided
      ? (thermal
          ? `<div class="r-center r-total" style="border:2px solid #000;padding:3px;margin:4px 0;">*** VOIDED ***</div>`
          : `<div style="border:3px solid #a13030;color:#a13030;font-size:22px;font-weight:700;text-align:center;padding:8px;margin:10px 0;letter-spacing:3px;">VOIDED — NOT A VALID SALE</div>`)
      : '';

    const footer = thermal
      ? `<div class="r-rule"></div>
         <div class="r-center r-small">
           ${esc(sale.receipt_footer || 'Thank you for your patronage.')}<br/>
           Goods sold are dispensed under pharmacist supervision.<br/>
           ${esc((window.Branding && Branding.poweredByLine && Branding.poweredByLine()) || '')}
         </div>`
      : Exporter.documentFooter('Goods dispensed under pharmacist supervision. Retain this receipt for your records.');

    return `${header(sale, { thermal })}${voidBanner}${meta}${bodyLines(sale, { thermal })}${complianceBlock(sale, { thermal })}${footer}`;
  }

  function printThermal(sale) {
    Exporter.printDocument(build(sale, { thermal: true }), {
      title: `Receipt ${String(sale.id).slice(0, 8)}`, thermal: true,
    });
  }

  function printA4(sale) {
    Exporter.printDocument(build(sale, { thermal: false }), {
      title: `Receipt ${String(sale.id).slice(0, 8)}`, thermal: false,
    });
  }

  // On-screen preview inside the existing modal, so the cashier sees exactly
  // what will print before committing paper to it.
  function screenHtml(sale) {
    return build(sale, { thermal: true });
  }

  return { printThermal, printA4, screenHtml, build };
})();

// BUG 111 — `window.Receipt` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.Receipt && Receipt.thing())` — a reasonable-looking defensive idiom that
// is in fact ALWAYS FALSE here, so the guarded branch never runs and the
// fallback is taken silently and forever.
//
// What that actually cost: every receipt and every printed report showed
// "PharmaRidge" as the letterhead instead of the client's own pharmacy name,
// on every white-labelled deployment, since day one. Nothing errored — the
// fallback was a legitimate-looking default.
//
// Publishing the module on `window` makes those guards true and keeps them
// honest as guards (a module genuinely not loaded is still falsy). Assigning
// here rather than rewriting ~11 call sites is deliberate: the next such
// guard someone writes will also work.
window.Receipt = Receipt;
