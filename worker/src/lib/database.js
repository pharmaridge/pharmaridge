// Request-scoped database accessor.
//
// D1 remains the default active provider. index.js stores the selected adapter
// on each Hono context; this helper gives routes/services one stable access
// point during the staged Turso migration while remaining compatible with unit
// tests that provide only c.env.DB.
function database(c) {
  if (c && typeof c.get === 'function') {
    const selected = c.get('database');
    if (selected) return selected;
  }
  if (c && c.env && c.env.DB) return c.env.DB;
  throw new Error('No database is configured for this request.');
}

module.exports = { database };
