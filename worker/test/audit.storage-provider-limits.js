// STORAGE PROVIDER LIMIT AUDIT — D1 keeps its 500 MB Free reference while
// the Turso adapter receives the current 5 GB Free reference ceiling.
const {
  getStorageHealth,
  D1_FREE_LIMIT_BYTES,
  TURSO_FREE_LIMIT_BYTES,
} = require('../src/lib/storageHealth');

let pass = 0; let fail = 0;
function check(label, yes, detail = '') { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } }

function fakeDatabase(provider) {
  return {
    ...(provider ? { provider } : {}),
    prepare(sql) {
      if (/sqlite_master/.test(sql)) return { all: async () => ({ results: [{ name: 'sales' }, { name: 'nafdac_catalog' }] }) };
      return { first: async () => ({ sales: 1000, nafdac_catalog: 6801 }) };
    },
  };
}

(async () => {
  console.log('=== STORAGE PROVIDER LIMIT AUDIT ===');
  const d1 = await getStorageHealth(fakeDatabase());
  const turso = await getStorageHealth(fakeDatabase('TURSO'));
  check('D1 default keeps the 500 MB free-tier reference', d1.provider === 'D1' && d1.limit_megabytes === 500 && D1_FREE_LIMIT_BYTES === 500 * 1024 * 1024, JSON.stringify(d1));
  check('Turso uses the 5 GB free-tier reference', turso.provider === 'TURSO' && turso.provider_label === 'Turso Free' && turso.limit_megabytes === 5120 && TURSO_FREE_LIMIT_BYTES === 5 * 1024 * 1024 * 1024, JSON.stringify(turso));
  check('the same estimated data has more capacity runway on Turso', turso.megabytes === d1.megabytes && turso.percent_used < d1.percent_used, JSON.stringify({ d1: d1.percent_used, turso: turso.percent_used }));
  check('storage response identifies the selected provider for UI copy', d1.provider_label === 'Cloudflare D1 Free' && turso.available && d1.available, JSON.stringify({ d1: d1.provider_label, turso: turso.provider_label }));
  console.log(`\nSTORAGE PROVIDER LIMIT AUDIT: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error('CRASH', error); process.exit(2); });
