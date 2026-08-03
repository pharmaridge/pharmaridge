// D1 STORAGE HEADROOM MONITORING.
//
// FOUND DURING A LONG-TERM DURABILITY AUDIT. Cloudflare D1's Free plan
// caps a database at 500 MB. Cloudflare's own documentation is explicit
// about what happens at that ceiling:
//
//   "Once you have reached your included storage limit, you will need to
//    delete unused databases or clean up stale data before you can
//    insert new data, create or alter tables or create indexes"
//   — https://developers.cloudflare.com/d1/platform/pricing/
//
//   Writes fail; READS AND DELETES KEEP WORKING.
//
// That failure mode is the dangerous one for a pharmacy. The app keeps
// loading, dashboards keep rendering, staff keep scanning — and every
// sale silently refuses to record. There is no warning and, before this
// module, no way for anyone to see it coming.
//
// MEASURED growth, not estimated: 1,000 realistic sales (3 line items,
// 1 payment, 4 GL lines each) were inserted into a real SQLite database
// built from these exact migrations, and the file growth measured:
//
//   2,859 bytes per completed sale
//
// The headroom figures below were RESTATED after an accuracy audit found
// the old ones optimistic. They previously ignored the fixed baseline —
// an empty migrated database plus the NAFDAC catalog is already ~5.9 MB —
// and billed the catalog at 380 bytes/row when it really costs 614. Both
// are corrected below and in ROW_COST_BYTES. Against the 494 MB that is
// actually left for trade, at the modelled 3,860 bytes/sale (2,859 raw
// x 1.35 whole-file overhead):
//
//   small PPMV      40 sales/day ->  ~54 MB/yr -> ~9.2 years of headroom
//   busy pharmacy  200 sales/day -> ~269 MB/yr -> ~1.8 years
//   3-branch group 600 sales/day -> ~806 MB/yr -> ~0.6 YEARS
//
// A three-branch group therefore fills the Free tier in roughly seven
// months of ordinary trading — sooner than the ten months previously
// documented. That is not a theoretical edge case; it is the growth path
// of a successful customer, and it arrives without warning.
//
// The business records driving that growth — sales, sale_items,
// sale_payments, gl_journal_entries, gl_journal_lines, debtor_ledger,
// creditor_ledger, staff_attendance, controlled_drug_register — are
// deliberately NEVER pruned. They are financial and regulatory evidence:
// NAFDAC/PCN inspection, FIRS tax records, wage disputes. Deleting them
// to stay under a hosting quota would be the wrong trade. So the answer
// is not retention; it is VISIBILITY, early enough to upgrade the plan
// before writes start failing.

// Free plan: 500 MB per database. Paid: 10 GB. We warn against the
// tighter ceiling because that is what this product deploys onto by
// default, and warning early on a Paid plan is harmless.
const D1_FREE_LIMIT_BYTES = 500 * 1024 * 1024;

// Warn with real runway left, not at the cliff edge. At 75% a busy
// pharmacy still has months to act; at 90% it is weeks.
const WARN_AT = 0.75;
const CRITICAL_AT = 0.90;

// The size of a freshly-migrated, EMPTY database: 37 tables, 12 views, 53
// indexes and a trigger, before a single business row exists. MEASURED by
// applying 0001 to a real SQLite file and VACUUMing. A row-count model
// cannot see this by construction, and omitting it made the whole estimate
// read low — see the write-up at the point of use below.
const EMPTY_SCHEMA_BYTES = 589824;

// HOW THE SIZE IS OBTAINED — and why it is an ESTIMATE.
//
// My first implementation used SQLite's table-valued pragma functions
// (`SELECT * FROM pragma_page_count()`). That works perfectly in plain
// better-sqlite3 and passed locally. Against REAL D1 it returns:
//
//   D1_ERROR: not authorized: SQLITE_AUTH
//
// D1 also does not compile in the `dbstat` virtual table
// ("no such table: dbstat"). Both were verified by execution against a
// real D1 database, not assumed — and the failure was caught only
// because this module was written to report unavailability honestly
// rather than guess. Reading code would not have found it; every local
// test said the feature worked.
//
// So the size is DERIVED from row counts using per-row costs MEASURED
// against this exact schema: 1,000 realistic sales were inserted into a
// real SQLite file built from these migrations and the growth measured
// at 2,859 bytes per completed sale (3 line items, 1 payment, 4 GL
// lines). The constants below decompose that figure per table so the
// estimate stays honest as the mix of activity changes.
//
// An estimate is the right tool here anyway: the purpose is to warn a
// proprietor MONTHS before a ceiling, not to bill them to the byte.
const ROW_COST_BYTES = {
  sales: 260,
  sale_items: 300,
  sale_payments: 200,
  gl_journal_entries: 250,
  gl_journal_lines: 190,
  stock_batches: 320,
  staff_attendance: 300,
  // BUG 75. One row per transfer/promotion. Tiny and bounded in practice (a
  // pharmacy moves people a handful of times a year), but it is per-event and
  // never pruned — it is permanent accountability — so it must be costed
  // rather than silently omitted.
  user_assignment_history: 260,
  // BUG 95. One row per "no change available" event, which in a busy shop is
  // several a day — genuinely per-transaction, and never pruned (a customer's
  // unclaimed money is not something to garbage-collect). MEASURED the same
  // way as the rest: 5,000 rows into a real SQLite file with all six indexes,
  // VACUUMed either side, giving 564 bytes per row. Higher than the other
  // ledger tables because the row carries a purchase summary, a name, a phone
  // and six indexes including three partial ones.
  change_owed: 564,
  // Branch safe. Per-movement and never pruned — an owner asking "where did
  // the reserve go?" needs the whole history. MEASURED the same way as the
  // rest (5,000 rows with both indexes, VACUUM either side): 406 bytes.
  branch_safe_ledger: 406,
  // BUG 108. One row per staged staff transfer. Short-lived by nature (it is
  // resolved the next time that person signs in) and rare — a pharmacy moves
  // somebody between branches a handful of times a year, not daily — but it
  // is a per-transaction table and every one of those must be in the model,
  // or the storage estimate quietly understates what a client will use.
  pending_user_transfers: 320,
  controlled_substance_register: 420,
  debtor_ledger: 220,
  creditor_ledger: 220,
  stock_adjustments: 240,
  login_attempts: 160,
  sync_change_log: 180,
  idempotency_keys: 400,
  // Corrected from 380 by direct measurement: the catalog's text columns and
  // three indexes cost 614 bytes per row, not 380 — a 1.6 MB understatement
  // across 6,801 rows, all of it in the FIXED part of the estimate.
  nafdac_catalog: 614,
  // MEASURED the same way as the rest (5,000 rows into a real SQLite file,
  // VACUUMed either side, so the figure includes this table's three
  // indexes): 351 bytes per row. Withholding-tax deductions are permanent
  // records — they back the credit notes a pharmacy issues and the tax
  // credits it claims — so they are never pruned and must be costed.
  wht_entries: 351,
  // BUG 47. MEASURED the same way as the rest (5,000 rows into a real
  // SQLite file, VACUUMed either side, so the figure includes this table's
  // indexes): 726 bytes per row — the most expensive row in the system,
  // because each conflict stores TWO complete JSON snapshots of the row
  // being overwritten (losing_version_json + winning_version_json).
  //
  // This table was classified as "bounded by configuration" alongside
  // branches/users/products and therefore costed at nothing. That was
  // wrong: a conflict row is written every time two devices edit the same
  // customer and the loser is overwritten, so it grows with TRADING, not
  // with setup. Live-reproduced: 12 alternating-device edits to ONE
  // customer produced 11 conflict rows.
  //
  // Nothing prunes it, and `POST /sync/conflicts/:id/review` only stamps
  // reviewed_at — it HIDES the row from the manager's list, it does not
  // delete it. So this is permanent, uncosted, per-transaction growth
  // against a 500 MB ceiling: exactly the gap wht_entries was found to
  // have. Retained deliberately (a conflict is evidence of two people
  // disagreeing about a customer record) but now honestly costed.
  sync_conflicts: 726,
};

/**
 * Estimates live database size from row counts (see the note above for
 * why a direct measurement is impossible on D1).
 *
 * Never throws: storage reporting must not be able to break the app it is
 * reporting on.
 */
async function getStorageHealth(db) {
  try {
    // Only count tables that actually EXIST. Hardcoding names is how the
    // first version broke: it referenced `controlled_drug_register` when
    // the real table is `controlled_substance_register`, and the whole
    // report failed with SQLITE_ERROR. Deriving the list from
    // sqlite_master means a renamed or future table degrades the estimate
    // slightly instead of taking the feature down.
    const { results: present } = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all();
    const existing = new Set(present.map((r) => r.name));
    const tables = Object.keys(ROW_COST_BYTES).filter((t) => existing.has(t));
    if (!tables.length) return { available: false, status: 'UNKNOWN', message: null, error: 'no known tables found' };
    // ONE query, not one per table: this runs on the dashboard and must
    // not consume the Workers Free plan's 50-subrequest budget.
    const sql = 'SELECT ' + tables
      .map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`)
      .join(', ');
    const counts = await db.prepare(sql).first();
    let bytes = 0;
    for (const t of tables) bytes += ((counts && counts[t]) || 0) * ROW_COST_BYTES[t];
    // Indexes, page overhead and the tables not itemised above. The
    // measured whole-file growth was ~1.35x the raw row bytes.
    bytes = Math.round(bytes * 1.35);
    // FIXED BASELINE. An accuracy audit — 800 real sales driven through
    // the real sales service into a real SQLite file, VACUUMed and
    // measured — showed the estimate reading 15.6% LOW, which is the
    // dangerous direction: it under-warns, and the entire purpose of this
    // figure is to warn a pharmacy BEFORE writes start failing.
    //
    // Decomposed, the per-sale cost was actually conservative (2,043 bytes
    // measured against the 2,859 the model assumes). The shortfall was
    // entirely in the fixed baseline:
    //
    //   * an empty database built from these migrations is already
    //     589,824 bytes — 37 tables, 12 views, 53 indexes and a trigger,
    //     none of which scale with row counts and none of which the
    //     row-count model could ever see;
    //   * the NAFDAC catalog's real cost is 614 bytes/row, not the 380 in
    //     ROW_COST_BYTES (its FTS-style text columns and three indexes),
    //     understating a fixed 4.2 MB by 1.6 MB.
    //
    // Adding the measured empty-schema floor corrects the larger half and
    // keeps the estimate on the safe side of reality. The catalog row cost
    // is corrected in ROW_COST_BYTES above.
    bytes += EMPTY_SCHEMA_BYTES;
    const ratio = bytes / D1_FREE_LIMIT_BYTES;
    return {
      bytes,
      megabytes: Math.round((bytes / 1024 / 1024) * 10) / 10,
      limit_megabytes: Math.round(D1_FREE_LIMIT_BYTES / 1024 / 1024),
      percent_used: Math.round(ratio * 1000) / 10,
      status: ratio >= CRITICAL_AT ? 'CRITICAL' : ratio >= WARN_AT ? 'WARNING' : 'OK',
      // Deliberately plain language: the reader is a pharmacy proprietor,
      // not an engineer, and the consequence must be unmistakable.
      message: ratio >= CRITICAL_AT
        ? 'This database is nearly full. When it fills, PharmaRidge will stop being able to record new sales — existing records stay readable. Contact PharmaRidge support now to upgrade storage.'
        : ratio >= WARN_AT
          ? 'This database is filling up. Sales, receipts and accounting records are kept permanently for tax and NAFDAC inspection, so storage only grows. Contact PharmaRidge support to plan an upgrade.'
          : null,
      available: true,
      estimated: true,
    };
  } catch (e) {
    // An older D1 build, or a permissions change, must not take the
    // dashboard down. Report unavailability honestly instead of guessing.
    return { available: false, status: 'UNKNOWN', message: null, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { getStorageHealth, D1_FREE_LIMIT_BYTES, WARN_AT, CRITICAL_AT };
