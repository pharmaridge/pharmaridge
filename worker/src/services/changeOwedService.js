// CHANGE OWED TO CUSTOMERS — BUG 95.
//
// The counter reality this exists for: goods come to N400, the customer hands
// over N500, and the shop has no N100 note. Before this module the system
// recorded `change_given = 100` — asserting the customer had been paid money
// they never received — and the drawer then expected N400 while physically
// holding N500, a phantom overage on every occurrence.
//
// See migrations/0003_change_owed.sql for the data model and the GL rationale.
// The short version: this is a LIABILITY. The full tendered cash is debited to
// CASH (so the drawer reconciles to what is actually in it) and the shortfall
// is credited to CHANGE_OWED_PAYABLE (because it is a named person's money).
const { round2 } = require('../lib/business');
const uuid = () => crypto.randomUUID().replace(/-/g, '');

// SEVEN DIGITS, as the client specified, and generated so a human can read it
// aloud over a counter and type it back correctly.
//
// The range is 1000000..9999999: seven significant digits with no leading
// zero, so the code cannot be mangled by a spreadsheet, an SMS, or anyone who
// drops the zero when reading it back. Collisions are handled by retrying
// against the UNIQUE index rather than by hoping — with a few thousand live
// claims the birthday-collision probability is small but not zero, and a
// duplicate code would hand one customer another's money.
async function generateClaimCode(db) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const n = 1000000 + Math.floor(Math.random() * 9000000);
    const code = String(n);
    const clash = await db.prepare('SELECT 1 AS x FROM change_owed WHERE claim_code = ?').bind(code).first();
    if (!clash) return code;
  }
  // Deliberately loud. Silently reusing a code, or falling back to something
  // longer than 7 digits that the printed slip cannot represent, would be
  // worse than refusing the operation.
  throw Object.assign(
    new Error('Could not allocate a unique 7-digit claim code. Please try again.'),
    { status: 503, code: 'CLAIM_CODE_EXHAUSTED' }
  );
}

// Builds the statements that record a change shortfall as part of the SALE's
// own atomic batch. Returned rather than executed so the claim can never exist
// without its sale, or vice versa.
//
// `saleSummary` snapshots what was bought AS TEXT at the time — the client
// asked for "auto input of product or products price owe and time" — so the
// claim still reads correctly years later even if the product is renamed or
// deleted.
async function buildShortfallStatements(db, {
  branchId, saleId, amount, customerId, customerName, customerPhone, saleSummary, recordedBy,
}) {
  const value = round2(amount);
  if (!(value > 0)) return { statements: [], claimCode: null };

  // Identification is REQUIRED but deliberately cheap: a name OR a phone
  // number is enough. Demanding a full customer record at a busy counter is
  // how a feature like this ends up unused, and an unused feature means the
  // cashier goes back to remembering.
  const name = (customerName || '').trim();
  const phone = (customerPhone || '').trim();
  if (!name && !phone) {
    throw Object.assign(
      new Error('Enter the customer\'s name or phone number before completing a sale that leaves change owed — '
        + 'it is the only way they can be paid back if they lose the claim slip.'),
      { status: 400, code: 'CHANGE_OWED_NEEDS_IDENTITY' }
    );
  }

  const claimCode = await generateClaimCode(db);
  // The id is generated HERE rather than read back after insertion, because
  // these statements have not run yet — they are appended to the sale's own
  // batch. An earlier draft of this function queried for the row immediately
  // after building the statement and got null every time, which would have
  // posted the GL entry against a null source id and silently broken the
  // liability's audit trail. Generate once, use for both the row and the
  // journal entry.
  const claimId = uuid();
  const statements = [db.prepare(`
    INSERT INTO change_owed (id, claim_code, branch_id, sale_id, customer_id, customer_name, customer_phone, amount, sale_summary, recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(claimId, claimCode, branchId, saleId, customerId || null,
    name || phone, phone || null, value, saleSummary || null, recordedBy || null)];

  return { statements, claimCode, claimId, amount: value };
}

// --- Lookup -------------------------------------------------------------
//
// Three ways in, because the client was explicit: "if the customer misplaced
// the seven digit number the person name or number can be used". The code is
// the fast path, never the only one.
async function findClaims(db, { branchId, query, status = 'OUTSTANDING', limit = 100 }) {
  const q = (query || '').trim();
  const params = [];
  let where = 'co.is_deleted = 0';
  if (status && status !== 'ALL') { where += ' AND co.status = ?'; params.push(status); }
  if (branchId) { where += ' AND co.branch_id = ?'; params.push(branchId); }
  if (q) {
    // A 7-digit all-numeric query is treated as a code first, but still falls
    // through to phone matching — a phone number is also all digits, and a
    // cashier typing "0803..." must not get an empty result because the input
    // looked code-shaped.
    where += ' AND (co.claim_code = ? OR co.customer_name LIKE ? OR co.customer_phone LIKE ?)';
    params.push(q, `%${q}%`, `%${q}%`);
  }
  const { results } = await db.prepare(`
    SELECT co.*, b.name AS branch_name, u.full_name AS recorded_by_name,
           s.id AS origin_sale_id, su.full_name AS settled_by_name
    FROM change_owed co
    JOIN branches b ON b.id = co.branch_id
    LEFT JOIN users u ON u.id = co.recorded_by
    LEFT JOIN users su ON su.id = co.settled_by
    LEFT JOIN sales s ON s.id = co.sale_id
    WHERE ${where}
    ORDER BY co.created_at DESC
    LIMIT ?
  `).bind(...params, Math.min(Number(limit) || 100, 500)).all();
  return results || [];
}

async function getClaim(db, id) {
  return db.prepare(`
    SELECT co.*, b.name AS branch_name, u.full_name AS recorded_by_name, su.full_name AS settled_by_name
    FROM change_owed co
    JOIN branches b ON b.id = co.branch_id
    LEFT JOIN users u ON u.id = co.recorded_by
    LEFT JOIN users su ON su.id = co.settled_by
    WHERE co.id = ? AND co.is_deleted = 0
  `).bind(id).first();
}

async function getClaimByCode(db, code) {
  return db.prepare(`
    SELECT co.*, b.name AS branch_name
    FROM change_owed co JOIN branches b ON b.id = co.branch_id
    WHERE co.claim_code = ? AND co.is_deleted = 0
  `).bind(String(code || '').trim()).first();
}

// Claims attached to a given sale — used so the ORIGINAL receipt can print the
// claim code, which the client asked for explicitly ("should appear in the
// initial purchase receipt too").
async function claimsForSale(db, saleId) {
  const { results } = await db.prepare(
    'SELECT * FROM change_owed WHERE sale_id = ? AND is_deleted = 0'
  ).bind(saleId).all();
  return results || [];
}

async function outstandingTotal(db, branchId) {
  const row = branchId
    ? await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM change_owed
                        WHERE status = 'OUTSTANDING' AND is_deleted = 0 AND branch_id = ?`).bind(branchId).first()
    : await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM change_owed
                        WHERE status = 'OUTSTANDING' AND is_deleted = 0`).first();
  return { claim_count: Number(row.n || 0), total_owed: round2(Number(row.total || 0)) };
}

// --- Settlement ---------------------------------------------------------
//
// Guarded so a claim can only ever be discharged ONCE. This is the same class
// of guard as the debtor-overpayment fix (Bug 81): the failure mode is paying
// the same person twice for the same shortfall, and it is invisible in a busy
// shop unless the system refuses.
function assertSettleable(claim) {
  if (!claim) {
    return Object.assign(new Error('No change claim found with that code, name or number.'),
      { status: 404, code: 'CHANGE_CLAIM_NOT_FOUND' });
  }
  if (claim.status === 'SETTLED') {
    return Object.assign(
      new Error(`This change was already paid out on ${String(claim.settled_at || '').slice(0, 16)}. `
        + 'Paying it again would hand over the money twice — check the claim history before overriding.'),
      { status: 409, code: 'CHANGE_ALREADY_SETTLED' }
    );
  }
  if (claim.status === 'WRITTEN_OFF') {
    return Object.assign(
      new Error('This change was written off by the Owner and is no longer outstanding. '
        + 'The Owner can reverse the write-off if it was a mistake.'),
      { status: 409, code: 'CHANGE_WRITTEN_OFF' }
    );
  }
  return null;
}

module.exports = {
  generateClaimCode, buildShortfallStatements,
  findClaims, getClaim, getClaimByCode, claimsForSale, outstandingTotal,
  assertSettleable,
};
