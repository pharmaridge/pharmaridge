// probe-receipt — BUG 105: text that fell off the edge of the thermal roll.
//
// Every previous round tested receipts by reading the HTML or by looking at a
// screen preview. A receipt is not a screen: it is 80mm of paper, and the only
// question that matters is WHAT LANDS ON IT. Printing the shipped renderer to
// a real 80mm page and reading the text back is what exposed this — the
// on-screen preview looked completely fine.
//
// Root cause was `.r-line span:last-child { white-space: nowrap }` in
// export.js's THERMAL_CSS. Intended to stop a money amount wrapping away from
// its label; but a line with an EMPTY right-hand cell — how every full-width
// instruction is emitted, `L(text, '')` — makes the FIRST span the :last-child
// too, so long text inherited nowrap and ran off the paper.
//
// Requires: bash test/devserver.sh 9001
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const PUB = path.join(__dirname, '..', '..', '..', 'public');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// Pull the REAL thermal stylesheet out of the shipped exporter, so this probe
// tests what ships rather than a copy that can drift (trap #43: assert intent,
// and here the "intent" is literally the production CSS).
function thermalCss() {
  const src = fs.readFileSync(path.join(PUB, 'js', 'export.js'), 'utf8');
  const m = /const THERMAL_CSS = `([\s\S]*?)`;/.exec(src);
  if (!m) throw new Error('THERMAL_CSS not found in public/js/export.js');
  return m[1];
}

async function printToRoll(browser, bodyHtml, file) {
  const p = await browser.newPage();
  await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    ${thermalCss()}
  </style></head><body class="print-thermal">${bodyHtml}</body></html>`, { waitUntil: 'load' });
  await p.pdf({ path: file, width: '80mm', printBackground: true });
  await p.close();
  return execSync(`pdftotext -layout ${file} -`).toString();
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  console.log('\n=== NOTHING RUNS OFF THE EDGE OF AN 80mm ROLL ===');
  {
    // The exact sentence that was being cut. Asserting the LAST WORD reaches
    // paper is the outcome; asserting the CSS selector would be implementation.
    const claim = 'Keep this. Bring the code (or your name/phone) to collect your change or use it on your next purchase.';
    const out = await printToRoll(browser,
      `<div class="r-line r-small"><span><span class="r-small">${claim}</span></span><span></span></div>`,
      '/tmp/probe-roll-1.pdf');
    const flat = out.replace(/\s+/g, ' ');
    check('the change-claim instruction prints to its final word',
      flat.includes('next purchase.'), JSON.stringify(out.trim().slice(-60)));
    check('...and no word is truncated mid-way', !/use i$/m.test(out.trim()));

    // The A4 wording is longer still and uses an em dash.
    const claimA4 = 'Keep this receipt. Bring the code — or your name / phone number — to collect your change, or use it against your next purchase.';
    const out2 = await printToRoll(browser,
      `<div class="r-line r-small"><span><span class="r-small">${claimA4}</span></span><span></span></div>`,
      '/tmp/probe-roll-2.pdf');
    check('the longer wording also prints complete',
      out2.replace(/\s+/g, ' ').includes('next purchase.'));
  }

  console.log('\n=== ...WITHOUT UNDOING WHAT THE OLD RULE PROTECTED ===');
  {
    // The nowrap existed for a reason: a money amount must never be split
    // across two lines, or a receipt can read "N12,500." / "00". Keep it.
    const out = await printToRoll(browser,
      `<div class="r-line"><span>Amoxicillin/Clavulanic Acid 625mg Film-Coated Tablets x14</span><span>N12,500.00</span></div>`,
      '/tmp/probe-roll-3.pdf');
    const flat = out.replace(/\s+/g, ' ');
    check('a money amount stays intact on one piece', flat.includes('N12,500.00'), flat.slice(0, 90));
    check('a long product name still prints in full', flat.includes('Tablets x14'));

    const out2 = await printToRoll(browser,
      `<div class="r-line r-total"><span><b>TOTAL</b></span><span><b>N1,234,567.89</b></span></div>`,
      '/tmp/probe-roll-4.pdf');
    check('a large TOTAL is not split', out2.replace(/\s+/g, ' ').includes('N1,234,567.89'));
  }

  console.log('\n=== A REAL RECEIPT, FROM THE REAL RENDERER, ONTO REAL PAPER ===');
  {
    // End to end: log in, take an actual sale, run Receipt.build() and print
    // the result. This is the only check here that would catch a regression
    // introduced in receipt.js rather than in the stylesheet.
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const set = (id, v) => {
        const e = document.getElementById(id); e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('login-username', 'owner'); set('login-pin', '1234');
    });
    await page.evaluate(() => document.getElementById('login-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
    // Receipt.build() calls Exporter.documentFooter(), so both must have
    // evaluated before we render. They are separate <script> tags and waiting
    // only on the session raced them ("Exporter is not defined" — my harness,
    // not the app).
    //
    // They are declared as top-level `const`, which does NOT create a
    // property on `window` — so `window.Exporter` is permanently undefined and
    // my first attempt at this wait timed out against a perfectly healthy
    // page. Reference the bindings directly instead.
    await page.waitForFunction(
      () => typeof Receipt !== 'undefined' && typeof Exporter !== 'undefined'
        && typeof Api !== 'undefined' && typeof UI !== 'undefined',
      { timeout: 20000 },
    );
    await new Promise((r) => setTimeout(r, 1200));

    const built = await page.evaluate(async () => {
      const sales = await Api.get('/sales?limit=15');
      const list = sales.results || sales;
      if (!list.length) return null;
      const full = await Api.get(`/sales/${list[0].id}`);
      return { html: Receipt.build(full, { thermal: true }), items: full.items.length, id: full.id };
    });
    check('a real sale could be loaded and rendered', !!built);
    if (built) {
      const out = await printToRoll(browser, built.html, '/tmp/probe-roll-real.pdf');
      const lines = out.split('\n').filter((l) => l.trim());
      // 74mm of Courier 11px is ~48 characters. Any line materially longer
      // than that did not fit and has been clipped by the printer.
      const tooLong = lines.filter((l) => l.trimEnd().length > 60);
      check('no line on the printed receipt exceeds the roll width',
        tooLong.length === 0, tooLong.slice(0, 2).join(' | '));
      check('the receipt carries a TOTAL', /TOTAL/i.test(out));
      check('the receipt names the business', out.trim().length > 60);
      // Currency must be the plain N prefix — a Naira glyph is tofu on many
      // thermal printers, which is why the whole product avoids it.
      check('no Unicode Naira sign reached the roll', !out.includes('\u20a6'));
    }
    await page.close();
  }

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
