// Retail categories are deliberately distinct from a medicine's therapeutic
// group. A pharmacy can sell medicines beside water, drinks, toiletries and
// accessories; keeping this bounded commercial category lets POS, stock and
// sales history report those lines accurately without misclassifying a drug.
const RETAIL_CATEGORIES = Object.freeze([
  { code: 'PHARMACEUTICALS', label: 'Pharmaceuticals' },
  { code: 'FOOD_DRINKS', label: 'Food & Drinks' },
  { code: 'ACCESSORIES', label: 'Accessories' },
  { code: 'BEAUTY_PERSONAL_CARE', label: 'Beauty & Personal Care' },
]);
const DEFAULT_RETAIL_CATEGORY = 'PHARMACEUTICALS';
const RETAIL_CATEGORY_CODES = new Set(RETAIL_CATEGORIES.map((entry) => entry.code));
function isRetailCategory(value) { return RETAIL_CATEGORY_CODES.has(value); }
function retailCategoryLabel(code) {
  const found = RETAIL_CATEGORIES.find((entry) => entry.code === code);
  return found ? found.label : code || DEFAULT_RETAIL_CATEGORY;
}
module.exports = { RETAIL_CATEGORIES, RETAIL_CATEGORY_CODES, DEFAULT_RETAIL_CATEGORY, isRetailCategory, retailCategoryLabel };
