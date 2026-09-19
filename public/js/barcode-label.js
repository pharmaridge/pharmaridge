// In-house barcode-label rendering and printing.
//
// The application uses Code 128 Set B for labels because it represents the
// generated PRD-… code (and existing internal codes) without pretending that
// an in-house value is a GS1-issued EAN/GTIN. Barcode scanners return the
// original text, which the POS resolves through the product_barcodes registry.
const BarcodeLabel = (() => {
  // Code 128 symbol patterns for values 0–106. Each digit is the width of an
  // alternating bar/space run; 106 is the seven-run stop symbol.
  const CODE128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];

  function escapeXml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function code128Values(value) {
    const text = String(value == null ? '' : value);
    if (!text) throw new Error('A barcode value is required.');
    const values = [104]; // Start Code B
    for (let index = 0; index < text.length; index++) {
      const codePoint = text.charCodeAt(index);
      if (codePoint < 32 || codePoint > 126) throw new Error('This barcode contains characters that cannot be printed as Code 128.');
      values.push(codePoint - 32);
    }
    const checksum = values.reduce((sum, valueCode, index) => sum + (index === 0 ? valueCode : valueCode * index), 0) % 103;
    values.push(checksum, 106);
    return values;
  }

  function svg(value, options = {}) {
    const moduleWidth = Number(options.moduleWidth) > 0 ? Number(options.moduleWidth) : 2;
    const height = Number(options.height) > 0 ? Number(options.height) : 82;
    const quietZone = Number(options.quietZone) >= 0 ? Number(options.quietZone) : 10;
    const patterns = code128Values(value).map((symbol) => CODE128[symbol]);
    const symbolWidth = patterns.reduce((sum, pattern) => sum + [...pattern].reduce((width, digit) => width + Number(digit), 0), 0);
    const width = (symbolWidth + (quietZone * 2)) * moduleWidth;
    let x = quietZone * moduleWidth;
    const bars = [];
    patterns.forEach((pattern) => {
      let isBar = true;
      [...pattern].forEach((digit) => {
        const runWidth = Number(digit) * moduleWidth;
        if (isBar) bars.push(`<rect x="${x}" y="0" width="${runWidth}" height="${height}"/>`);
        x += runWidth;
        isBar = !isBar;
      });
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Barcode ${escapeXml(value)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>${bars.join('')}</svg>`;
  }

  function unitLabel(unitType) {
    return ({ BASE_UNIT: 'Single / base unit', PACK: 'Pack', CARTON: 'Carton' })[unitType] || String(unitType || '');
  }

  // Uses the browser's native print pipeline so the user can select any
  // installed external USB, Bluetooth, network, thermal, or label printer.
  // Browser security intentionally prevents silently selecting a printer.
  function printSticker({ barcode, productName, unitType, label }) {
    const printWindow = window.open('', 'pharmaridge-barcode-sticker', 'width=440,height=500');
    if (!printWindow) throw new Error('The browser blocked the print window. Allow pop-ups for PharmaRidge, then try again.');
    const title = productName || 'Product';
    const subtitle = [unitLabel(unitType), label].filter(Boolean).join(' · ');
    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Barcode sticker — ${escapeXml(title)}</title><style>
      @page { size: 58mm 40mm; margin: 0; }
      * { box-sizing: border-box; }
      html, body { width: 58mm; height: 40mm; margin: 0; background: #fff; color: #000; font-family: Arial, Helvetica, sans-serif; }
      .sticker { width: 58mm; height: 40mm; padding: 2.5mm 3mm 1.8mm; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
      .name { font-size: 10pt; font-weight: 700; line-height: 1.15; max-height: 23pt; overflow: hidden; }
      .detail { min-height: 10pt; font-size: 7.5pt; line-height: 1.1; color: #222; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .barcode { width: 100%; height: 16mm; display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .barcode svg { width: 100%; height: 100%; }
      .value { font-size: 8pt; letter-spacing: .55pt; text-align: center; font-family: "Courier New", monospace; white-space: nowrap; }
    </style></head><body><main class="sticker"><div class="name">${escapeXml(title)}</div><div class="detail">${escapeXml(subtitle)}</div><div class="barcode">${svg(barcode, { moduleWidth: 1.25, height: 92, quietZone: 10 })}</div><div class="value">${escapeXml(barcode)}</div></main><script>window.onload=function(){window.focus();window.print();};</script></body></html>`);
    printWindow.document.close();
  }

  return { svg, printSticker, unitLabel };
})();
window.BarcodeLabel = BarcodeLabel;
