// probe-syncgaps — BUGS 107 & 108, plus the prepaid-capacity rule.
//
// THE CLASS THIS PROBE EXISTS FOR: work that was VALID when it was created
// offline, arriving after the world has moved on. Every earlier round tested
// each feature in isolation with a live connection. Nothing tested what
// happens when a perfectly ordinary offline action lands after a manager has
// changed something underneath it.
//
//   Bug 107 — a manager transfers a batch; a cashier at the SOURCE branch
//             sells from it offline; the queued sale replays after the
//             transfer was raised. Receiving then failed permanently
//             ("Source batch no longer has enough stock") and the stock was
//             frozen at both branches.
//   Bug 108 — a manager reassigns a cashier who is working offline. Their
//             branch changed under their feet, so their queued sales, open
//             till and clock-in belonged to a branch they had left.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const login = async (u, p = '1234') => (await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: u, pin: p }),
})).json());

(async () => {
  const owner = await login('owner');
  const OH = { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` };
  const admin = await login('admin');
  const AH = { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` };
  const get = async (p, h = OH) => JSON.parse(await (await fetch(BASE + p, { headers: h })).text());
  const post = async (p, body, h = OH) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: h, body: JSON.stringify(body || {}) });
    return { status: r.status, text: await r.text() };
  };
  const listOf = (x) => (x && x.results) ? x.results : x;

  // =====================================================================
  console.log('\n=== BUG 107: AN OFFLINE SALE MUST NOT FREEZE A TRANSFER ===');
  // =====================================================================
  {
    const plist = listOf(await get('/api/products'));
    const sellable = new Map(plist.filter((p) => !p.is_controlled && p.dispensing_type !== 'POM').map((p) => [p.id, p]));
    const rows = listOf(await get('/api/stock')).filter((r) => r.quantity_remaining > 20 && sellable.has(r.product_id));
    check('a stocked batch is available to test with', rows.length > 0);
    if (!rows.length) { console.log(`\nRESULT: ${pass} passed, ${fail + 1} failed`); process.exit(1); }
    const b = rows[0];
    const blist = listOf(await get('/api/branches'));
    const dest = blist.find((x) => x.id !== b.branch_id && x.is_active);

    const SOLD = 3;
    const tr = await post('/api/transfers', {
      to_branch_id: dest.id, stock_batch_id: b.id, quantity: b.quantity_remaining,
    });
    check('the manager can transfer the whole batch', tr.status === 201, `${tr.status} ${tr.text.slice(0, 80)}`);
    const tid = JSON.parse(tr.text).id;

    await post('/api/till/open', { branch_id: b.branch_id, opening_float: 5000 });
    const sale = await post('/api/sales', {
      branch_id: b.branch_id,
      items: [{ product_id: b.product_id, unit_type: 'BASE_UNIT', quantity: SOLD }],
      payments: [{ method: 'CASH', amount: b.selling_price_per_unit * SOLD }],
    });
    check("the cashier's queued offline sale is still accepted", sale.status === 201,
      `${sale.status} ${sale.text.slice(0, 90)}`);

    const rec = await post(`/api/transfers/${tid}/receive`);
    check('the destination CAN still receive the transfer', rec.status === 200,
      `${rec.status} ${rec.text.slice(0, 110)}`);

    const t = listOf(await get('/api/transfers')).find((x) => x.id === tid);
    check('...and it completes rather than sticking at PENDING',
      t && t.status === 'RECEIVED', t && t.status);
    check('the transfer was corrected by exactly what was sold',
      t && t.quantity_received === t.quantity - SOLD,
      t ? `intended ${t.quantity}, received ${t.quantity_received}` : 'no row');
    check('the shortfall is recorded, not hidden', t && t.shortfall_quantity === SOLD,
      t ? String(t.shortfall_quantity) : 'no row');
    check('...and it carries an explanation a manager can read',
      !!(t && t.shortfall_reason && t.shortfall_reason.length > 30));
    check('intent still equals received plus shortfall (nothing invented or lost)',
      t && t.quantity === t.quantity_received + t.shortfall_quantity);

    // WHERE THE STOCK LANDED is the thing that actually matters (trap #89).
    const after = listOf(await get('/api/stock'));
    const newBatch = after.find((r) => r.id === t.new_batch_id);
    check('the destination holds exactly what moved — no more, no less',
      newBatch && newBatch.quantity_remaining === t.quantity_received,
      newBatch ? `${newBatch.quantity_remaining} vs ${t.quantity_received}` : 'destination batch missing');
    const src = after.find((r) => r.id === t.stock_batch_id);
    check('the source is drawn down by what left, never negative',
      !src || src.quantity_remaining >= 0, src ? String(src.quantity_remaining) : 'row gone');

    const tb = await get('/api/gl/trial-balance');
    const sum = tb.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('the trial balance still balances after the correction',
      Math.abs(sum) < 0.005, `sum(dr-cr)=${sum}`);
    const clearing = tb.find((r) => r.account_code === 'INTER_BRANCH_TRANSFER_CLEARING');
    check('the inter-branch clearing account nets to zero',
      !clearing || Math.abs(clearing.total_debits - clearing.total_credits) < 0.005,
      clearing ? `dr=${clearing.total_debits} cr=${clearing.total_credits}` : 'none');
  }

  // =====================================================================
  console.log('\n=== BUG 107b: IF EVERYTHING SOLD, SAY SO — DO NOT HANG ===');
  // =====================================================================
  {
    const plist = listOf(await get('/api/products'));
    const sellable = new Map(plist.filter((p) => !p.is_controlled && p.dispensing_type !== 'POM').map((p) => [p.id, p]));
    let rows = listOf(await get('/api/stock')).filter((r) => r.quantity_remaining >= 2 && r.quantity_remaining <= 40 && sellable.has(r.product_id));
    // Fresh seeds carry large batches. Create one deliberately small real
    // receipt so the exhaustion path is always exercised rather than skipped.
    if (!rows.length) {
      const branches = listOf(await get('/api/branches')).filter((b) => b.is_active);
      const source = branches[0];
      const suppliers = listOf(await get('/api/suppliers'));
      let supplier = suppliers[0];
      if (!supplier) {
        const made = await post('/api/suppliers', { name: `Exhaustion Supplier ${Date.now()}`, phone: '08030000004', address: 'Audit depot' });
        supplier = made.status === 201 ? JSON.parse(made.text) : null;
      }
      const product = [...sellable.values()][0];
      if (source && supplier && product) {
        const po = await post('/api/purchase-orders', {
          branch_id: source.id, supplier_id: supplier.id,
          items: [{ product_id: product.id, quantity_ordered: 10, expected_unit_cost: 100 }],
        });
        if (po.status === 201) {
          const poId = JSON.parse(po.text).id;
          await post(`/api/purchase-orders/${poId}/receive`, { on_credit: false,
            batches: [{ product_id: product.id, quantity_received: 10, cost_price_per_unit: 100,
              selling_price_per_unit: 150, batch_no: `EXHAUST-${Date.now()}`, expiry_date: '2030-12-31' }] });
        }
      }
      rows = listOf(await get('/api/stock')).filter((r) => r.quantity_remaining >= 2 && r.quantity_remaining <= 40 && sellable.has(r.product_id));
    }
    if (!rows.length) { check('a small batch exists for the exhaustion case', false); }
    else {
      const b = rows[0];
      const blist = listOf(await get('/api/branches'));
      const dest = blist.find((x) => x.id !== b.branch_id && x.is_active);
      const tr = await post('/api/transfers', { to_branch_id: dest.id, stock_batch_id: b.id, quantity: b.quantity_remaining });
      if (tr.status !== 201) { check('a transfer could be raised for the exhaustion case', false, tr.text.slice(0, 80)); }
      else {
        const tid = JSON.parse(tr.text).id;
        await post('/api/till/open', { branch_id: b.branch_id, opening_float: 5000 });
        // Sell the ENTIRE batch offline before the transfer is received.
        //
        // The price is NOT this batch's own selling_price_per_unit: FEFO picks
        // whichever batch of that product expires soonest, which may be a
        // different (cheaper or dearer) one, so pricing the sale from my batch
        // failed reconciliation — my harness, not the app (trap #63/#64).
        // Ask the server what it charged by reading the created sale back, or
        // simply let the payment follow the FEFO price by quoting from the
        // cheapest same-product batch present at that branch.
        const sameProduct = listOf(await get('/api/stock'))
          .filter((r) => r.product_id === b.product_id && r.branch_id === b.branch_id && r.quantity_remaining > 0);
        const totalUnits = sameProduct.reduce((a, r) => a + r.quantity_remaining, 0);
        const fefo = sameProduct.slice().sort((x, y) => String(x.expiry_date).localeCompare(String(y.expiry_date)))[0];
        const qty = Math.min(b.quantity_remaining, totalUnits);
        const sale = await post('/api/sales', {
          branch_id: b.branch_id,
          items: [{ product_id: b.product_id, unit_type: 'BASE_UNIT', quantity: qty }],
          payments: [{ method: 'CASH', amount: fefo.selling_price_per_unit * qty }],
        });
        check('the whole batch can be sold offline at the source', sale.status === 201, sale.text.slice(0, 110));

        // FEFO decides WHICH batch a sale consumes, and it need not be the one
        // being transferred. Selling "the quantity of batch X" therefore does
        // not guarantee batch X is empty — my first version asserted the
        // exhaustion path while the batch still had stock, and the transfer
        // (correctly) completed. Drain the specific batch until it is actually
        // empty before testing what happens when nothing is left.
        let guardSell = 0;
        while (guardSell++ < 12) {
          const cur = listOf(await get('/api/stock')).find((r) => r.id === b.id);
          if (!cur || cur.quantity_remaining <= 0) break;
          const pool = listOf(await get('/api/stock'))
            .filter((r) => r.product_id === b.product_id && r.branch_id === b.branch_id && r.quantity_remaining > 0)
            .sort((x, y) => String(x.expiry_date).localeCompare(String(y.expiry_date)));
          const head = pool[0];
          const n = Math.min(head.quantity_remaining, 25);
          const s2 = await post('/api/sales', {
            branch_id: b.branch_id,
            items: [{ product_id: b.product_id, unit_type: 'BASE_UNIT', quantity: n }],
            payments: [{ method: 'CASH', amount: head.selling_price_per_unit * n }],
          });
          if (s2.status !== 201) break;
        }
        const drained = listOf(await get('/api/stock')).find((r) => r.id === b.id);
        check('the transferred batch really is empty before receiving',
          !drained || drained.quantity_remaining === 0,
          drained ? String(drained.quantity_remaining) : 'row gone');

        const rec = await post(`/api/transfers/${tid}/receive`);
        check('receiving an exhausted transfer is refused CLEARLY, not with a dead end',
          rec.status === 409 && /TRANSFER_SOURCE_EXHAUSTED/.test(rec.text),
          `${rec.status} ${rec.text.slice(0, 110)}`);
        const t = listOf(await get('/api/transfers')).find((x) => x.id === tid);
        check('...and it is auto-cancelled rather than left stuck',
          t && t.status === 'CANCELLED', t && t.status);
        check('...with the reason recorded', !!(t && t.shortfall_reason));
      }
    }
  }

  // =====================================================================
  console.log('\n=== BUG 108: MOVING A PERSON NEEDS THEIR CONFIRMATION ===');
  // =====================================================================
  {
    const ulist = listOf(await get('/api/users'));
    const blist = listOf(await get('/api/branches'));
    const staff = ulist.find((u) => u.role === 'STAFF' && u.branch_id && u.is_active);
    const dest = blist.find((b) => b.id !== staff.branch_id && b.is_active);

    const t = await post(`/api/users/${staff.id}/transfer`,
      { role: 'STAFF', branch_id: dest.id, reason: 'probe: seasonal cover at the new shop' });
    check('a transfer can be raised', t.status === 200, `${t.status} ${t.text.slice(0, 90)}`);
    const body = JSON.parse(t.text);
    check('it is STAGED, not applied instantly',
      !!body.pending_transfer && body.pending_transfer.status === 'AWAITING_CONFIRMATION',
      JSON.stringify(body.pending_transfer || {}).slice(0, 80));

    // THE INVARIANT THAT MATTERS: their access is untouched, so offline work
    // created at the old branch cannot be orphaned.
    const row = listOf(await get('/api/users')).find((u) => u.id === staff.id);
    check('the person has NOT moved yet — offline work stays valid',
      row.branch_id === staff.branch_id, `${row.branch_id} vs ${staff.branch_id}`);

    const sess = await login(staff.username);
    const SH = { 'content-type': 'application/json', authorization: `Bearer ${sess.token}` };
    const mine = listOf(await get('/api/users/transfers/pending/mine', SH));
    check('the staff member can see the request waiting for them',
      Array.isArray(mine) && mine.length >= 1, `n=${Array.isArray(mine) ? mine.length : 'n/a'}`);
    const pid = mine[0].id;
    check('...and it names where they are going and who asked',
      !!(mine[0].to_branch_name && mine[0].requested_by_name),
      `${mine[0].to_branch_name} / ${mine[0].requested_by_name}`);

    const byOwner = await post(`/api/users/transfers/pending/${pid}/confirm`, {}, OH);
    check('somebody else cannot confirm it on their behalf', byOwner.status === 403,
      `${byOwner.status} ${byOwner.text.slice(0, 80)}`);

    const dup = await post(`/api/users/${staff.id}/transfer`,
      { role: 'STAFF', branch_id: dest.id, reason: 'probe: a competing second request' });
    check('a second competing request is refused', dup.status === 409, `${dup.status}`);

    const conf = await post(`/api/users/transfers/pending/${pid}/confirm`, {}, SH);
    check('the staff member can confirm', conf.status === 200, `${conf.status} ${conf.text.slice(0, 90)}`);
    const moved = listOf(await get('/api/users')).find((u) => u.id === staff.id);
    check('...and only THEN do they actually move', moved.branch_id === dest.id,
      `${moved.branch_id} vs ${dest.id}`);
    const hist = listOf(await get(`/api/users/${staff.id}/assignment-history`));
    check('the move is written to the permanent history', hist.length >= 1, `n=${hist.length}`);
  }

  // =====================================================================
  console.log('\n=== BUG 109: A PROMOTION IS STAGED TOO, AND READS AS ONE ===');
  // =====================================================================
  {
    // The client asked for promotions and demotions to be confirmed like a
    // branch move. They ALREADY were — a role change and a branch move share
    // one endpoint, so Bug 108's staging covered both. Asserted here because
    // "it already works" is a claim that needs a test, not a memory.
    const ulist = listOf(await get('/api/users'));
    const cand = ulist.find((u) => u.role === 'STAFF' && u.branch_id && u.is_active);
    const before = cand.role;

    const t = await post(`/api/users/${cand.id}/transfer`,
      { role: 'MANAGER', branch_id: cand.branch_id, reason: 'probe: promoted to run this branch' });
    check('a promotion can be raised', t.status === 200, `${t.status} ${t.text.slice(0, 90)}`);
    const pt = JSON.parse(t.text).pending_transfer;
    check('a PROMOTION is staged, not applied instantly',
      !!pt && pt.status === 'AWAITING_CONFIRMATION', JSON.stringify(pt || {}).slice(0, 80));
    check('...at the SAME branch (it is a role change, not a move)',
      pt && pt.from_branch_id === pt.to_branch_id);

    const mid = listOf(await get('/api/users')).find((u) => u.id === cand.id);
    check('their role is unchanged while it is pending', mid.role === before, `${mid.role} vs ${before}`);

    const sess = await login(cand.username);
    const CH = { 'content-type': 'application/json', authorization: `Bearer ${sess.token}` };
    // While pending they must still be refused manager-only work — the
    // promotion has not happened, so granting it early would be the mirror
    // image of the bug.
    const early = await fetch(`${BASE}/api/users`, { headers: CH });
    check('...and they cannot use manager powers yet', early.status === 403, `${early.status}`);

    const conf = await post(`/api/users/transfers/pending/${pt.id}/confirm`, {}, CH);
    check('they can confirm the promotion', conf.status === 200, `${conf.status} ${conf.text.slice(0, 90)}`);
    const after = listOf(await get('/api/users')).find((u) => u.id === cand.id);
    check('...and only THEN is the role applied', after.role === 'MANAGER', after.role);

    const sess2 = await login(cand.username);
    const CH2 = { authorization: `Bearer ${sess2.token}` };
    const nowOk = await fetch(`${BASE}/api/users`, { headers: CH2 });
    check('...and the new powers actually work', nowOk.status === 200, `${nowOk.status}`);

    // DEMOTION must stage identically — the risk is the same in reverse.
    const d = await post(`/api/users/${cand.id}/transfer`,
      { role: 'STAFF', branch_id: cand.branch_id, reason: 'probe: stepped back to the counter' });
    check('a demotion is staged too', d.status === 200 && !!JSON.parse(d.text).pending_transfer, `${d.status}`);
    const midD = listOf(await get('/api/users')).find((u) => u.id === cand.id);
    check('...and they keep their manager powers until they accept',
      midD.role === 'MANAGER', midD.role);
    const pd = JSON.parse(d.text).pending_transfer.id;
    const sess3 = await login(cand.username);
    const CH3 = { 'content-type': 'application/json', authorization: `Bearer ${sess3.token}` };
    const confD = await post(`/api/users/transfers/pending/${pd}/confirm`, {}, CH3);
    check('a demotion can be confirmed', confD.status === 200, `${confD.status}`);
    const afterD = listOf(await get('/api/users')).find((u) => u.id === cand.id);
    check('...and applies on confirmation', afterD.role === 'STAFF', afterD.role);
  }

  // =====================================================================
  console.log('\n=== BUG 108b: CONFIRMATION MUST NOT BECOME A NEW DEAD END ===');
  // =====================================================================
  {
    const ulist = listOf(await get('/api/users'));
    const blist = listOf(await get('/api/branches'));
    const used = [];
    const pick = () => ulist.find((u) => u.role === 'STAFF' && u.branch_id && u.is_active && !used.includes(u.id));

    // Decline
    const s1 = pick(); used.push(s1.id);
    const d1 = blist.find((b) => b.id !== s1.branch_id && b.is_active);
    const t1 = await post(`/api/users/${s1.id}/transfer`, { role: 'STAFF', branch_id: d1.id, reason: 'probe: decline path' });
    const p1 = JSON.parse(t1.text).pending_transfer.id;
    const sess1 = await login(s1.username);
    const S1 = { 'content-type': 'application/json', authorization: `Bearer ${sess1.token}` };
    const bare = await post(`/api/users/transfers/pending/${p1}/decline`, {}, S1);
    check('declining without a reason is refused', bare.status === 400, `${bare.status}`);
    const dec = await post(`/api/users/transfers/pending/${p1}/decline`, { reason: 'probe: my till is still open here' }, S1);
    check('declining with a reason is accepted', dec.status === 200, `${dec.status}`);
    const r1 = listOf(await get('/api/users')).find((u) => u.id === s1.id);
    check('a declined transfer moves nobody', r1.branch_id === s1.branch_id);
    const redo = await post(`/api/users/transfers/pending/${p1}/confirm`, {}, S1);
    check('a resolved request cannot be confirmed afterwards', redo.status === 409, `${redo.status}`);

    // Force — the escape hatch for someone who has left
    const s2 = pick(); used.push(s2.id);
    const d2 = blist.find((b) => b.id !== s2.branch_id && b.is_active);
    const t2 = await post(`/api/users/${s2.id}/transfer`, { role: 'STAFF', branch_id: d2.id, reason: 'probe: they resigned' });
    const p2 = JSON.parse(t2.text).pending_transfer.id;

    const bm = ulist.find((u) => u.role === 'MANAGER' && u.branch_id && u.is_active);
    if (bm) {
      const bs = await login(bm.username);
      const BH = { 'content-type': 'application/json', authorization: `Bearer ${bs.token}` };
      const badForce = await post(`/api/users/transfers/pending/${p2}/force`, {}, BH);
      check('a pinned Branch Manager cannot force a transfer through',
        badForce.status === 403, `${badForce.status} ${badForce.text.slice(0, 70)}`);
    }
    const forced = await post(`/api/users/transfers/pending/${p2}/force`, {}, OH);
    check('an Owner CAN force it (nobody is ever permanently stuck)',
      forced.status === 200, `${forced.status} ${forced.text.slice(0, 90)}`);
    const r2 = listOf(await get('/api/users')).find((u) => u.id === s2.id);
    check('...and the person actually moves', r2.branch_id === d2.id);
    const h2 = JSON.stringify(listOf(await get(`/api/users/${s2.id}/assignment-history`)));
    check('the history says it was FORCED, not agreed to', /forced through/i.test(h2));
  }

  // =====================================================================
  console.log('\n=== A CONFIRMED TRANSFER STILL CLOSES THE OLD SHIFT ===');
  // =====================================================================
  {
    // probe-transfer.js owned this guarantee, but its section-G fixtures
    // drifted when a transfer became two-step. Re-asserted here against the
    // real flow so the behaviour is genuinely covered, not just assumed:
    // a shift left open at the OLD branch must be closed by the move, or the
    // person is on duty at a branch they have left, forever.
    const ulist2 = listOf(await get('/api/users'));
    const blist2 = listOf(await get('/api/branches'));
    const who = ulist2.find((u) => u.role === 'STAFF' && u.branch_id && u.is_active);
    const to = blist2.find((b) => b.id !== who.branch_id && b.is_active);
    const sess = await login(who.username);
    const WH = { 'content-type': 'application/json', authorization: `Bearer ${sess.token}` };

    // Make sure they are clocked in somewhere before we move them.
    await fetch(`${BASE}/api/attendance/clock-in`, { method: 'POST', headers: WH, body: JSON.stringify({ branch_id: who.branch_id }) });

    const staged = await post(`/api/users/${who.id}/transfer`,
      { branch_id: to.id, reason: 'probe: mid-shift move' });
    check('a transfer can be staged for someone mid-shift', staged.status === 200, `${staged.status}`);
    if (staged.status === 200) {
      const pid = JSON.parse(staged.text).pending_transfer.id;
      const conf = await post(`/api/users/transfers/pending/${pid}/confirm`, {}, WH);
      check('...they can confirm it', conf.status === 200, `${conf.status} ${conf.text.slice(0, 90)}`);
      if (conf.status === 200) {
        const cb = JSON.parse(conf.text);
        check('...the open shift is auto-closed by the move',
          cb.transfer && cb.transfer.shift_auto_closed === true,
          JSON.stringify(cb.transfer || {}).slice(0, 100));
        const att = listOf(await get('/api/attendance')).filter((a) => a.user_id === who.id);
        const atOld = att.find((a) => a.branch_id === who.branch_id);
        check('...and that shift stays recorded against the OLD branch',
          !!atOld, 'no shift row at the original branch');
        check('...with a clock-out time set (nobody is on duty forever)',
          !atOld || !!atOld.clock_out_at, String(atOld && atOld.clock_out_at));
      }
    }
  }

  // =====================================================================
  console.log('\n=== PREPAID CAPACITY: THE CLIENT OWNS THE SEATS THEY BOUGHT ===');
  // =====================================================================
  {
    const before = await get('/api/admin/settings', AH);
    check('the plan states a branch and staff ceiling',
      Number.isInteger(before.max_branches) && Number.isInteger(before.max_staff),
      `${before.max_branches}/${before.max_staff}`);

    const selfRaise = await fetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: OH, body: JSON.stringify({ max_branches: 999 }),
    });
    check('the CLIENT cannot raise their own ceiling', selfRaise.status === 403, `${selfRaise.status}`);

    // Fill to the cap, then confirm the wall.
    let guard = 0;
    let blocked = null;
    while (guard++ < 60) {
      const r = await post('/api/branches', { name: `Capacity probe ${Date.now()}-${guard}`, address: '1 Probe Road', license_type: 'PPMV' });
      if (r.status !== 201) { blocked = r; break; }
    }
    check('the client is stopped at the ceiling they paid for',
      !!blocked && blocked.status === 403 && /PLAN_LIMIT_EXCEEDED/.test(blocked.text),
      blocked ? `${blocked.status} ${blocked.text.slice(0, 90)}` : 'never blocked in 60 attempts');
    check('...and the refusal tells them who to contact to buy more',
      !!blocked && /contact/i.test(blocked.text));

    const now = await get('/api/admin/settings', AH);
    const raise = await fetch(`${BASE}/api/admin/settings`, {
      method: 'PUT', headers: AH, body: JSON.stringify({ max_branches: now.max_branches + 1 }),
    });
    check('the vendor ADMIN can raise it', raise.status === 200, `${raise.status}`);
    const okNow = await post('/api/branches', { name: `Post raise ${Date.now()}`, address: '2 Probe Road', license_type: 'PPMV' });
    check('the client is unblocked immediately, with no restart', okNow.status === 201, `${okNow.status}`);
    const blockedAgain = await post('/api/branches', { name: `Over again ${Date.now()}`, address: '3 Probe Road', license_type: 'PPMV' });
    check('...and stopped again one past the NEW ceiling', blockedAgain.status === 403, `${blockedAgain.status}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
