// BARCODE LABEL AUDIT — verifies the browser-only Code 128 sticker renderer
// without depending on a physical printer. The browser's native print dialog
// is the supported hand-off point for installed label/thermal printers.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }

(async () => {
  console.log('=== BARCODE LABEL / EXTERNAL PRINTER AUDIT ===');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://example.test/' });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../../public/js/barcode-label.js'), 'utf8'));
  const labels = dom.window.BarcodeLabel;
  const code = 'PRD-A1B2C3D4E5F60708';
  const rendered = labels.svg(code);
  check('internal product code renders as a self-contained Code 128 SVG', /<svg\b/.test(rendered) && /<rect\b/.test(rendered) && rendered.includes(code), rendered.slice(0, 120));
  check('unsupported control characters are rejected instead of producing an unreadable label', (() => { try { labels.svg('BAD\nCODE'); return false; } catch (_) { return true; } })());

  let printedHtml = '';
  const printWindow = {
    document: {
      open() {},
      write(html) { printedHtml = html; },
      close() {},
    },
    set opener(value) { this._opener = value; },
  };
  dom.window.open = () => printWindow;
  labels.printSticker({ barcode: code, productName: 'Barcode Audit Drink', unitType: 'PACK', label: '10-bottle pack' });
  check('sticker output has the 58 × 40 mm print layout', printedHtml.includes('@page { size: 58mm 40mm;') && printedHtml.includes('Barcode Audit Drink'));
  check('sticker includes the machine-readable barcode and invokes the native print path', printedHtml.includes(code) && printedHtml.includes('window.print()'));
  check('printer hand-off describes physical external-printer selection in the products UI', fs.readFileSync(path.join(__dirname, '../../public/js/views/products.js'), 'utf8').includes('USB, Bluetooth, network, thermal, or label printer'));
  check('barcode column remains database-unique in the two-migration baseline', /barcode\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(fs.readFileSync(path.join(__dirname, '../migrations/0001_initial_schema.sql'), 'utf8')));

  console.log(`\nBARCODE LABEL AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
