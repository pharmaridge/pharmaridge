const { Hono } = require('hono');
const { authRequired, resolveScopedBranchId, pinnedBranchIdOf } = require('../lib/auth');

const controlledRegister = new Hono();
controlledRegister.use('*', authRequired);

controlledRegister.get('/', async (c) => {
  const branchId = resolveScopedBranchId(c);
  // BUG 50 — surface the VOID status of the sale behind each entry.
  //
  // Live-reproduced: a controlled sale (codeine linctus, buyer "Chidi
  // Okeke", NIN recorded) was voided. Stock came back, the GL reversed,
  // the debtor ledger reversed, the WHT credit was withdrawn — but this
  // register still stated flatly that the buyer had RECEIVED the drug.
  // A NAFDAC inspector reconciling the register against stock movements
  // finds a dispensing the pharmacy cannot account for, and the pharmacy
  // has no way to explain it from this record.
  //
  // Same class as BUG 26 (the WHT register kept a live credit after a
  // void), and the answer is the same: ANNOTATE, never erase. Deleting
  // the row would destroy the audit trail of a controlled drug leaving
  // and returning, which is strictly worse than the bug.
  //
  // Crucially this is a READ-TIME JOIN, not a column update. The table is
  // deliberately append-only and hash-chained (see the schema comment and
  // verifyChain below); mutating a row would break the chain and destroy
  // the tamper-evidence that makes this register worth keeping. The hash
  // covers only the dispensing facts — buyer, quantity, prescriber — and
  // those never change. Whether the SALE was later voided is a fact about
  // the sale, and it lives in `sales`.
  let sql = `
    SELECT r.*, p.name AS product_name, b.name AS branch_name, u.full_name AS dispensed_by_name,
           COALESCE(s.status, 'COMPLETED')          AS sale_status,
           CASE WHEN s.status = 'VOIDED' THEN 1 ELSE 0 END AS is_voided,
           s.void_reason                             AS void_reason,
           vu.full_name                              AS voided_by_name
    FROM controlled_substance_register r
    JOIN products p ON p.id = r.product_id
    JOIN branches b ON b.id = r.branch_id
    JOIN users u ON u.id = r.dispensed_by
    LEFT JOIN sales s ON s.id = r.sale_id
    LEFT JOIN users vu ON vu.id = s.voided_by
    WHERE 1=1
  `;
  const params = [];
  if (branchId) { sql += ' AND r.branch_id = ?'; params.push(branchId); }
  const productId = c.req.query('product_id');
  if (productId) { sql += ' AND r.product_id = ?'; params.push(productId); }
  sql += ' ORDER BY r.created_at DESC LIMIT 500';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Recomputes the hash chain for a branch (mirrors the original
// implementation's verifyControlledRegisterChain).
async function verifyChain(db, branchId) {
  const { results: rows } = await db.prepare('SELECT * FROM controlled_substance_register WHERE branch_id = ? ORDER BY created_at ASC, rowid ASC').bind(branchId).all();
  let prevHash = null;
  for (const r of rows) {
    const canonical = JSON.stringify({
      id: r.id, branchId: r.branch_id, saleId: r.sale_id, saleItemId: r.sale_item_id, productId: r.product_id,
      quantityDispensed: r.quantity_dispensed, buyerName: r.buyer_name, buyerPhone: r.buyer_phone,
      buyerIdType: r.buyer_id_type, buyerIdNumber: r.buyer_id_number, prescriptionId: r.prescription_id,
      dispensedBy: r.dispensed_by, createdAt: r.created_at, prevHash,
    });
    const expected = await sha256Hex(canonical);
    // The stored prev_hash column uses the 'GENESIS' sentinel (not
    // NULL) for a branch's very first entry — see the fork-guard fix +
    // full rationale in worker/src/services/salesService.js and
    // migration 010 — but the HASH was always computed against literal
    // `null` for a genesis entry. Re-derive the hashing-equivalent
    // value from the stored column before comparing.
    const storedPrevHashForComparison = r.prev_hash === 'GENESIS' ? null : r.prev_hash;
    if (expected !== r.entry_hash || storedPrevHashForComparison !== prevHash) {
      return { valid: false, brokenAt: r.id, checkedRows: rows.length };
    }
    prevHash = r.entry_hash;
  }
  return { valid: true, checkedRows: rows.length };
}

controlledRegister.get('/verify/:branchId', async (c) => {
  const user = c.get('user');
  const branchId = c.req.param('branchId');
  // Same class of fix as transfers/adjustments: this checked STAFF only,
  // so a branch-pinned MANAGER could run the controlled-drug register
  // hash-chain verification for ANOTHER branch. That register is a
  // PCN-regulated record and its verification result reveals whether a
  // different branch's controlled-drug audit trail has been tampered
  // with — not something a foreign branch manager should be able to
  // probe. Any branch-pinned user is now confined to their own branch.
  {
    const pinned = pinnedBranchIdOf(user);
    if (pinned && pinned !== branchId) {
      return c.json({ error: 'You can only verify your own branch\'s controlled drug register.', code: 'BRANCH_SCOPE_VIOLATION' }, 403);
    }
  }
  return c.json(await verifyChain(c.env.DB, branchId));
});

module.exports = controlledRegister;
