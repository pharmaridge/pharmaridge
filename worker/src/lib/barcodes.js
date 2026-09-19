// Barcode normalisation/validation for pharmacy counter scanning.
// Standard EAN-8, UPC-A, EAN-13 and GTIN-14 numeric codes use their real
// check digit. Non-numeric in-house labels are supported only as clear,
// deliberate alphanumeric codes (for example INT-WATER-01), never as a loose
// malformed numeric string that a scanner could misread.
function normalizeBarcode(raw) {
  const value = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!value) return '';
  return /^\d[\d\s-]*$/.test(value) ? value.replace(/[\s-]/g, '') : value.replace(/\s+/g, '');
}
function hasValidGtinCheckDigit(code) {
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(code[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(code.at(-1));
}
function validateBarcode(raw) {
  const barcode = normalizeBarcode(raw);
  if (!barcode) return { barcode: '', error: 'A barcode is required.' };
  if (/^\d+$/.test(barcode)) {
    if (![8, 12, 13, 14].includes(barcode.length)) return { barcode, error: 'A numeric barcode must be EAN-8, UPC-A, EAN-13 or GTIN-14 length (8, 12, 13 or 14 digits).' };
    if (!hasValidGtinCheckDigit(barcode)) return { barcode, error: 'This numeric barcode has an invalid GS1 check digit. Check the code printed on the product.' };
    return { barcode, error: null };
  }
  if (!/^[A-Z][A-Z0-9._-]{2,63}$/.test(barcode)) return { barcode, error: 'An internal barcode/code must start with a letter and use 3–64 letters, numbers, dots, hyphens or underscores.' };
  return { barcode, error: null };
}
module.exports = { normalizeBarcode, validateBarcode };
