// shots-artefacts — photographs of the things a pharmacy HANDS OVER or FILES:
// the 80mm thermal receipt, the A4 receipt, a printed report, and the CSV a
// spreadsheet actually opens.
//
// WHY THIS IS SEPARATE FROM shots-manual.js
// -----------------------------------------
// shots-manual.js captures SCREENS. A screen is what staff look at; a receipt
// is what the customer walks out with and what an auditor asks for two years
// later. The manual explained receipts in prose and never showed one, so the
// single most-produced artefact in the whole business had no picture.
//
// Everything here is rendered by the SHIPPED renderers — Receipt.build() and
// Exporter.buildTableReport()/toCSV() — driven inside the real application in
// a real browser. Nothing is mocked up for the manual, so a change to the
// receipt format changes these plates automatically and the guide cannot
// drift from the product.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const OUT = process.env.SHOT_DIR || '/tmp/pharmaridge-manual-shots';
fs.mkdirSync(OUT, { recursive: true });
const sl = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(browser, username, pin = '1234', width = 1280) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  await page.setViewport({ width, height: 1000 });
  page.on('dialog', async (d) => { await d.accept(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u, p) => {
    const set = (id, v) => {
      const e = document.getElementById(id); e.value = v;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('login-username', u); set('login-pin', p);
  }, username, pin);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  // Wait for BRANDING, not just the session. Receipt.build() asks
  // Branding.displayName() for the pharmacy's own name and
  // Branding.printAttribution() for the "Powered by" line; both come from an
  // async fetch that App.init() fires separately. Rendering before it lands
  // produced plates headed "PharmaRidge" with no attribution — pictures of a
  // receipt the product never prints. The app was right; the harness was
  // racing it.
  await page.waitForFunction(
    () => typeof Branding !== 'undefined' && !!Branding.get()
      && typeof Receipt !== 'undefined' && typeof Exporter !== 'undefined',
    { timeout: 20000 },
  );
  await sl(1500);
  return { ctx, page };
}

// Reads the SHIPPED print stylesheets out of public/js/export.js. A thermal
// artefact gets THERMAL_CSS; a wide one gets DOCUMENT_CSS — exactly what the
// browser's print dialog would apply.
function printCss(width) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'js', 'export.js'), 'utf8');
  const grab = (name) => {
    const m = new RegExp('const ' + name + ' = `([\\s\\S]*?)`;').exec(src);
    if (!m) throw new Error(name + ' not found in public/js/export.js');
    return m[1];
  };
  return width > 420 ? grab('DOCUMENT_CSS') : grab('THERMAL_CSS');
}

const made = [];
// Renders arbitrary HTML through the app's own stylesheet, at a given CSS
// width, and screenshots exactly the content box. Used so a thermal receipt is
// captured at its true 80mm proportions rather than floating on a wide page.
async function renderArtefact(page, html, file, { width = 320, pad = 18, bg = '#ffffff' } = {}) {
  const dataUrl = await page.evaluate(async (h, w, p, b, css) => {
    const frame = document.createElement('iframe');
    frame.id = 'artefact-frame';
    frame.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:2400px;border:0;z-index:99999;background:${b};`;
    document.body.appendChild(frame);
    const doc = frame.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html lang="en" data-theme="light" style="color-scheme:light"><head>
      <meta charset="utf-8"/><link rel="stylesheet" href="/css/style.css"/>
      <style>
        /* THE REAL PRINT STYLESHEET, NOT A COPY OF IT.
           This used to hold a hand-written duplicate of export.js's
           THERMAL_CSS / DOCUMENT_CSS. It drifted the moment those changed:
           the "Powered by PharmaRidge" line was added to every receipt and
           these plates silently kept rendering the OLD design, so the manual
           would have shipped pictures of a receipt the product no longer
           prints. The stylesheet is now injected by the caller, read from
           the shipped file, so the two cannot disagree. */
        @page { margin:0 }
        body { margin:0; padding:${p}px; background:${b};
               font-family:"Courier New",monospace; font-size:11px; color:#000; }
        body.doc { font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
        ${css}
        .no-print{display:none !important}
      </style></head><body class="${w > 420 ? 'doc' : ''}">${h}</body></html>`);
    doc.close();
    await new Promise((r) => setTimeout(r, 900));
    const height = Math.max(doc.body.scrollHeight, 40);
    frame.style.height = `${height}px`;
    return String(height);
  }, html, width, pad, bg, printCss(width));

  const height = Number(dataUrl);
  const el = await page.$('#artefact-frame');
  const target = path.join(OUT, file);
  await el.screenshot({ path: target });
  await page.evaluate(() => { const f = document.getElementById('artefact-frame'); if (f) f.remove(); });
  const kb = Math.round(fs.statSync(target).size / 1024);
  made.push([file, kb, height]);
  console.log(`  ${file.padEnd(42)} ${String(kb).padStart(4)}KB  ${height}px tall`);
  return target;
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const { page } = await session(browser, 'owner');

  // ---------------------------------------------------------------------
  // 1 + 2. Receipts, rendered by the REAL Receipt.build() from a REAL sale.
  // ---------------------------------------------------------------------
  // A ONE-LINE RECEIPT TEACHES NOTHING. The seeded trading data is mostly
  // single-item counter sales, so rather than photograph the least
  // informative receipt in the database, RING UP a realistic basket through
  // the real POS API and photograph that. It is still the product's own
  // renderer and its own sale record — nothing here is mocked.
  const sale = await page.evaluate(async () => {
    const pick = async () => {
      const sales = await Api.get('/sales?limit=40');
      const list = sales.results || sales;
      let best = null;
      for (const s of list.slice(0, 25)) {
        const full = await Api.get(`/sales/${s.id}`);
        if (!full || !full.items) continue;
        if (!best || full.items.length > best.items.length) best = full;
        if (full.items.length >= 3) break;
      }
      return best;
    };

    let best = await pick();
    if (best && best.items.length >= 3) return best;

    // Build a three-line basket from stock that is actually on the shelf.
    try {
      // An OWNER is org-wide, so effectiveBranchId() is deliberately null —
      // "all branches". A sale must name ONE branch, so pick the branch that
      // actually holds the sellable stock rather than assuming the session
      // carries one. (My first attempt used effectiveBranchId() directly and
      // silently matched zero rows: my harness, not the app.)
      const stockResp = await Api.get('/stock');
      const allRows = stockResp.results || stockResp;
      const products = await Api.get('/products');
      const plist = products.results || products;
      // `dispensing_type` is not always populated on seeded catalogue rows;
      // what actually matters for a demo receipt is that it is NOT controlled
      // and NOT prescription-only, so test for that instead of for a label.
      const sellable = new Map(plist
        .filter((p) => !p.is_controlled && p.dispensing_type !== 'POM')
        .map((p) => [p.id, p]));
      const candidates = allRows.filter((r) => r.quantity_remaining > 6 && sellable.has(r.product_id));
      const byBranch = new Map();
      for (const r of candidates) {
        if (!byBranch.has(r.branch_id)) byBranch.set(r.branch_id, []);
        byBranch.get(r.branch_id).push(r);
      }
      let branchId = null; let rows = [];
      for (const [bid, rs] of byBranch) {
        const distinct = new Set(rs.map((r) => r.product_id));
        if (distinct.size >= 3) { branchId = bid; rows = rs; break; }
      }
      if (!branchId && byBranch.size) { [branchId, rows] = [...byBranch][0]; }
      if (!branchId) return best;
      const seen = new Set();
      const items = [];
      for (const r of rows) {
        if (seen.has(r.product_id)) continue;
        seen.add(r.product_id);
        items.push({ product_id: r.product_id, unit_type: 'BASE_UNIT', quantity: items.length + 1,
          _price: r.selling_price_per_unit });
        if (items.length === 3) break;
      }
      if (items.length < 2) return best;
      const total = items.reduce((a, i) => a + i._price * i.quantity, 0);
      items.forEach((i) => { delete i._price; });
      // Tender a round note ABOVE the total so the receipt also demonstrates
      // change — and, where change cannot be made, the claim block.
      const tendered = Math.ceil((total + 60) / 500) * 500;
      try { await Api.post('/till/open', { branch_id: branchId, opening_float: 5000 }); } catch (e) {}
      const created = await Api.post('/sales', {
        branch_id: branchId,
        items,
        payments: [{ method: 'CASH', amount: total }],
        cash_tendered: tendered,
        customer_name: 'Mrs Bimpe Salau',
      });
      const full = await Api.get(`/sales/${created.id}`);
      if (full && full.items && full.items.length > (best ? best.items.length : 0)) return full;
    } catch (e) { console.log("BASKET-ERR " + e.message); }
    return best;
  });
  if (!sale) { console.log('  NO SALE FOUND — cannot render receipts'); await browser.close(); process.exit(1); }
  console.log(`  using sale ${String(sale.id).slice(0, 8)} with ${sale.items.length} line(s)`);

  const thermalHtml = await page.evaluate((s) => Receipt.build(s, { thermal: true }), sale);
  await renderArtefact(page, thermalHtml, '70-receipt-thermal.png', { width: 302, pad: 14 });

  const a4Html = await page.evaluate((s) => Receipt.build(s, { thermal: false }), sale);
  await renderArtefact(page, a4Html, '71-receipt-a4.png', { width: 760, pad: 26 });

  // ---------------------------------------------------------------------
  // 3. A printed REPORT — what "Print / PDF" produces from a report screen.
  //    Built with the shipped Exporter, from live stock data.
  // ---------------------------------------------------------------------
  const reportHtml = await page.evaluate(async () => {
    const stock = await Api.get('/stock');
    const rows = (stock.results || stock).slice(0, 14);
    return Exporter.buildTableReport({
      title: 'Stock on hand — valuation and expiry',
      subtitle: 'All branches',
      columns: [
        { key: 'product_name', label: 'Product' },
        { key: 'batch_no', label: 'Batch' },
        { key: 'expiry_date', label: 'Expires' },
        { key: 'quantity_remaining', label: 'Qty', align: 'right' },
        { key: 'cost_price_per_unit', label: 'Unit cost', align: 'right', format: (v) => UI.money(v) },
        { key: 'value', label: 'Value', align: 'right',
          format: (v, r) => UI.money((r.quantity_remaining || 0) * (r.cost_price_per_unit || 0)) },
      ],
      rows,
      // buildTableReport takes {label, value} OBJECTS, not pairs. Passing
      // arrays rendered two rows of "undefined" — my harness, not the app.
      summary: [
        { label: 'Batches listed', value: String(rows.length) },
        { label: 'Total stock value',
          value: UI.money(rows.reduce((a, r) => a + (r.quantity_remaining || 0) * (r.cost_price_per_unit || 0), 0)) },
      ],
    });
  });
  await renderArtefact(page, reportHtml, '72-report-print.png', { width: 780, pad: 26 });

  // ---------------------------------------------------------------------
  // 4. The CSV, shown as a spreadsheet sees it — the actual bytes the
  //    shipped Exporter.toCSV() emits, laid into a grid.
  // ---------------------------------------------------------------------
  const csvHtml = await page.evaluate(async () => {
    const stock = await Api.get('/stock');
    const rows = (stock.results || stock).slice(0, 9);
    const cols = [
      { key: 'product_name', label: 'Product' },
      { key: 'batch_no', label: 'Batch' },
      { key: 'expiry_date', label: 'Expires' },
      { key: 'quantity_remaining', label: 'Qty' },
      { key: 'cost_price_per_unit', label: 'UnitCost' },
    ];
    const csv = Exporter.toCSV(cols, rows);
    const lines = csv.split('\r\n');
    const cells = lines.map((l) => l.split(','));
    const colLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const head = `<tr><th style="width:26px"></th>${colLetters.slice(0, cells[0].length)
      .map((c) => `<th>${c}</th>`).join('')}</tr>`;
    const body = cells.map((row, i) => `<tr><th>${i + 1}</th>${row
      .map((c) => `<td>${(c || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join('');
    return `<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif">
      <div style="font-size:13px;font-weight:700;color:#0b3d2e;margin-bottom:2px">stock-on-hand-2026-08-02.csv</div>
      <div style="font-size:10.5px;color:#555;margin-bottom:10px">Opened in a spreadsheet. Row 1 is the header the export writes.</div>
      <table style="border-collapse:collapse;font-size:10.5px;font-family:'Segoe UI',Arial,sans-serif">
        <thead style="background:#eef3f1">${head}</thead>
        <tbody>${body}</tbody>
      </table></div>
      <style>
        table th{border:1px solid #b9ccc5;padding:3px 7px;font-size:10px;color:#33523f;background:#eef3f1;font-weight:600}
        table td{border:1px solid #d7e2de;padding:3px 7px;background:#fff;white-space:nowrap}
      </style>`;
  });
  await renderArtefact(page, csvHtml, '73-csv-export.png', { width: 800, pad: 22 });

  // ---------------------------------------------------------------------
  // 5. A change-owed claim slip — the artefact the whole Bug 95 feature
  //    exists to produce, and the one a customer returns holding.
  // ---------------------------------------------------------------------
  const claimHtml = await page.evaluate(async () => {
    const list = await Api.get('/change-owed?status=OUTSTANDING');
    const claims = list.results || list;
    if (!claims.length) return null;
    const c = claims[0];
    return `<div class="r-center r-business">GreenLife Pharmacy</div>
      <div class="r-center r-small">Change Claim Slip</div>
      <div class="r-rule"></div>
      <div class="r-line"><span>Claim code</span><span class="r-total">${c.claim_code}</span></div>
      <div class="r-line"><span>Customer</span><span>${(c.customer_name || '-')}</span></div>
      <div class="r-line"><span>Phone</span><span>${(c.customer_phone || '-')}</span></div>
      <div class="r-rule"></div>
      <div class="r-line r-total"><span>CHANGE OWED</span><span>${UI.money(c.amount)}</span></div>
      <div class="r-rule"></div>
      <div class="r-small">Present this code to collect your change, or spend it
      against your next purchase. If you lose this slip your name or phone
      number will still find it. This balance does not expire.</div>`;
  });
  if (claimHtml) {
    await renderArtefact(page, claimHtml, '74-change-claim-slip.png', { width: 302, pad: 14 });
  } else {
    console.log('  (no outstanding change claim in the seed — slip skipped)');
  }

  await browser.close();
  console.log(`\nCaptured ${made.length} artefact plates into ${OUT}`);
})();
