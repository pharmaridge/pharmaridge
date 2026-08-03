// MANAGER — FULL-CIRCLE AUDIT.
//
// MANAGER is the most nuanced role in the product because it is really TWO
// roles sharing one enum value, distinguished only by whether the user row
// carries a branch_id:
//
//   General Manager  (branch_id NULL) -> org-wide, sees and acts everywhere
//   Branch Manager   (branch_id SET)  -> pinned, must see NOTHING of any other
//                                        branch's money, stock or people
//
// That distinction is derived, not stored, so every authorisation decision
// depends on one helper (pinnedBranchIdOf) being consulted at two chokepoints
// (resolveScopedBranchId / assertBranchAccess). A single route that forgets is
// a tenant-isolation hole inside the same pharmacy.
//
// Five questions:
//   1. Does a General Manager have the org-wide reach the job needs?
//   2. Is a Branch Manager genuinely SEALED into their branch — reads AND
//      writes, including via a forged branch_id in a request body?
//   3. Does the manager/owner boundary hold (no self-promotion, no widening
//      their own powers)?
//   4. Does the manager/staff boundary hold (overrides need a reason, no
//      touching a peer manager)?
//   5. Do the owner's permission levers actually constrain a real manager?
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
const notes = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function note(m) { notes.push(m); console.log('  ..   ' + m); }

async function login(username, pin) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const b = await r.json();
  return { status: r.status, ...b };
}
async function api(method, path, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: j };
}
const listOf = (x) => (Array.isArray(x) ? x : (x && x.results) || []);

(async () => {
  const GM = await login('manager', '1234');      // General Manager, org-wide
  const BM = await login('lagos.mgr', '1234');    // Branch Manager, Lagos only
  const O = await login('owner', '1234');
  const S = await login('lagos.staff', '1234');
  const MS = await login('minna.staff', '1234');
  const A = await login('admin', '1234');
  const tGM = GM.token, tBM = BM.token, tO = O.token, tS = S.token, tA = A.token;

  const branches = listOf((await api('GET', '/api/branches', { token: tGM })).body);
  const lagos = branches.find((b) => b.id === BM.user.branch_id);
  const other = branches.find((b) => b.id !== BM.user.branch_id && b.is_active);
  check('the fixture has two distinct branches to test isolation across', !!lagos && !!other,
    `lagos=${lagos && lagos.name} other=${other && other.name}`);

  console.log('\n=== A. THE TWO MANAGER KINDS ARE DISTINGUISHED CORRECTLY ===');
  check('General Manager is org-wide (no branch_id)', !GM.user.branch_id, String(GM.user.branch_id));
  check('...and is labelled "General Manager"', GM.user.role_label === 'General Manager', String(GM.user.role_label));
  check('Branch Manager is pinned to a branch', !!BM.user.branch_id, String(BM.user.branch_id));
  check('...and is labelled "Branch Manager"', BM.user.role_label === 'Branch Manager', String(BM.user.role_label));
  check('both are stored as the same role enum (the split is DERIVED)',
    GM.user.role === 'MANAGER' && BM.user.role === 'MANAGER',
    `${GM.user.role}/${BM.user.role}`);

  console.log('\n=== B. A GENERAL MANAGER CAN ACTUALLY RUN THE BUSINESS ===');
  const gmReads = [
    ['/api/dashboard/summary', 'org-wide dashboard'],
    ['/api/dashboard/branches-breakdown', 'per-branch money'],
    ['/api/gl/trial-balance', 'trial balance'],
    ['/api/gl/balance-sheet', 'balance sheet'],
    ['/api/sales', 'sales history'],
    ['/api/stock', 'stock'],
    ['/api/products', 'products'],
    ['/api/customers', 'debtors'],
    ['/api/suppliers', 'creditors'],
    ['/api/expenses', 'expenses'],
    ['/api/purchase-orders', 'purchase orders'],
    ['/api/transfers', 'transfers'],
    ['/api/attendance', 'attendance'],
    ['/api/till', 'till sessions'],
    ['/api/users', 'staff list'],
    ['/api/sync/overview', 'sync health'],
    ['/api/wht/entries', 'WHT register'],
  ];
  for (const [p, label] of gmReads) {
    const r = await api('GET', p, { token: tGM });
    check(`General Manager can read ${label}`, r.status === 200, `${p} -> ${r.status}`);
  }
  const gmSummary = (await api('GET', '/api/dashboard/summary', { token: tGM })).body;
  check('...and the default scope really is ALL branches',
    gmSummary.scope && gmSummary.scope.all_branches === true, JSON.stringify(gmSummary.scope));
  let gmDrill = true;
  for (const b of branches) {
    if ((await api('GET', `/api/dashboard/summary?branch_id=${b.id}`, { token: tGM })).status !== 200) gmDrill = false;
  }
  check('...and can drill into every branch', gmDrill, `${branches.length} branches`);

  console.log('\n=== C. A BRANCH MANAGER IS SEALED INTO THEIR BRANCH (READS) ===');
  // This is the tenant-isolation boundary INSIDE one pharmacy. A live audit
  // once showed a manager reading 275,000 of stock at a branch they were never
  // assigned to; these checks exist so that cannot come back.
  const bmSummary = (await api('GET', '/api/dashboard/summary', { token: tBM })).body;
  check('a Branch Manager\'s default scope is their OWN branch, not the org',
    bmSummary.scope && bmSummary.scope.all_branches !== true, JSON.stringify(bmSummary.scope));

  const forgedRead = await api('GET', `/api/dashboard/summary?branch_id=${other.id}`, { token: tBM });
  const forgedBody = forgedRead.body || {};
  check('...and naming another branch in the query does NOT widen it',
    forgedRead.status === 403
    || (forgedBody.scope && forgedBody.scope.branch_id === BM.user.branch_id)
    || (forgedBody.scope && forgedBody.scope.all_branches !== true),
    `status=${forgedRead.status} scope=${JSON.stringify(forgedBody.scope)}`);

  const bmStock = listOf((await api('GET', `/api/stock?branch_id=${other.id}`, { token: tBM })).body);
  const leaked = bmStock.filter((s) => s.branch_id && s.branch_id !== BM.user.branch_id);
  check('a Branch Manager cannot read another branch\'s STOCK', leaked.length === 0,
    `${leaked.length} foreign rows leaked`);

  const bmSales = listOf((await api('GET', `/api/sales?branch_id=${other.id}`, { token: tBM })).body);
  const leakedSales = bmSales.filter((s) => s.branch_id && s.branch_id !== BM.user.branch_id);
  check('...nor another branch\'s SALES', leakedSales.length === 0, `${leakedSales.length} foreign rows`);

  const bmTill = listOf((await api('GET', `/api/till?branch_id=${other.id}`, { token: tBM })).body);
  const leakedTill = bmTill.filter((t) => t.branch_id && t.branch_id !== BM.user.branch_id);
  check('...nor another branch\'s TILL sessions (cash accountability)', leakedTill.length === 0,
    `${leakedTill.length} foreign rows`);

  const bmAtt = listOf((await api('GET', `/api/attendance?branch_id=${other.id}`, { token: tBM })).body);
  const leakedAtt = bmAtt.filter((a) => a.branch_id && a.branch_id !== BM.user.branch_id);
  check('...nor another branch\'s ATTENDANCE (payroll)', leakedAtt.length === 0, `${leakedAtt.length} foreign rows`);

  const bmUsers = listOf((await api('GET', '/api/users', { token: tBM })).body);
  const foreignStaff = bmUsers.filter((u) => u.role === 'STAFF' && u.branch_id && u.branch_id !== BM.user.branch_id);
  check('...nor another branch\'s STAFF accounts', foreignStaff.length === 0,
    `${foreignStaff.length} foreign staff visible`);

  console.log('\n=== D. A BRANCH MANAGER IS SEALED INTO THEIR BRANCH (WRITES) ===');
  // Reads leaking is bad; writes leaking is worse. The historical hole was
  // `user.role === 'STAFF' ? user.branch_id : body.branch_id`, which pinned
  // only STAFF and let a pinned MANAGER write anywhere via the body.
  const foreignExpense = await api('POST', '/api/expenses', {
    token: tBM, body: { branch_id: other.id, category: 'diesel', amount: 100, description: 'cross-branch probe' },
  });
  check('a Branch Manager cannot post an EXPENSE to another branch',
    foreignExpense.status === 403
    || (foreignExpense.status === 201 && foreignExpense.body.branch_id === BM.user.branch_id),
    `status=${foreignExpense.status} branch=${foreignExpense.body && foreignExpense.body.branch_id}`);

  const otherStock = listOf((await api('GET', `/api/stock?branch_id=${other.id}`, { token: tGM })).body);
  const otherBatch = otherStock.find((s) => Number(s.quantity_remaining) > 2);
  if (otherBatch) {
    const foreignAdj = await api('POST', '/api/adjustments', {
      token: tBM,
      body: { branch_id: other.id, stock_batch_id: otherBatch.id, quantity_change: -1, reason: 'DAMAGED', notes: 'probe' },
    });
    check('a Branch Manager cannot ADJUST another branch\'s stock', foreignAdj.status >= 400,
      `status=${foreignAdj.status} ${JSON.stringify(foreignAdj.body).slice(0, 90)}`);
  } else { note('no adjustable batch at the other branch — adjustment isolation not exercised'); }

  const foreignStaffCreate = await api('POST', '/api/users', {
    token: tBM,
    body: { full_name: 'Cross Branch Hire', username: `xbranch-${Date.now()}`, pin: '4321', role: 'STAFF', branch_id: other.id },
  });
  check('a Branch Manager cannot hire into another branch', foreignStaffCreate.status >= 400,
    `status=${foreignStaffCreate.status} ${JSON.stringify(foreignStaffCreate.body).slice(0, 90)}`);

  const foreignStaffRow = listOf((await api('GET', '/api/users', { token: tGM })).body)
    .find((u) => u.role === 'STAFF' && u.branch_id === other.id);
  if (foreignStaffRow) {
    const takeover = await api('PUT', `/api/users/${foreignStaffRow.id}`, {
      token: tBM, body: { pin: '9999' },
    });
    check('a Branch Manager cannot reset a FOREIGN cashier\'s PIN (account takeover)',
      takeover.status === 403 || takeover.status === 404,
      `status=${takeover.status} ${JSON.stringify(takeover.body).slice(0, 90)}`);
    const kill = await api('PUT', `/api/users/${foreignStaffRow.id}`, { token: tBM, body: { is_active: false } });
    check('...nor deactivate them (halting another branch\'s trading)',
      kill.status === 403 || kill.status === 404, `status=${kill.status}`);
  } else { note('no foreign STAFF row found — cross-branch takeover not exercised'); }

  console.log('\n=== D2. BRANCH TRANSFER IS THE ONE CROSS-BRANCH FEATURE — AND IT IS FENCED ===');
  {
    // A transfer legitimately spans two branches, which makes it the obvious
    // escalation route for a pinned manager: PULL stock out of a branch you
    // cannot otherwise see, or RECEIVE goods addressed to someone else.
    const prods2 = listOf((await api('GET', '/api/products', { token: tGM })).body);
    const safeIds = new Set(prods2.filter((p) => !p.is_controlled).map((p) => p.id));
    const theirs = listOf((await api('GET', `/api/stock?branch_id=${other.id}`, { token: tGM })).body)
      .find((s) => Number(s.quantity_remaining) > 5);
    const ours = listOf((await api('GET', `/api/stock?branch_id=${lagos.id}`, { token: tGM })).body)
      .find((s) => Number(s.quantity_remaining) > 5 && safeIds.has(s.product_id));

    if (theirs) {
      const pull = await api('POST', '/api/transfers', {
        token: tBM, body: { from_branch_id: other.id, to_branch_id: lagos.id, stock_batch_id: theirs.id, quantity: 1 },
      });
      check('a Branch Manager cannot PULL stock out of another branch', pull.status === 403,
        `status=${pull.status} ${JSON.stringify(pull.body).slice(0, 90)}`);
      check('...with a branch-scope code', pull.body && pull.body.code === 'BRANCH_SCOPE_VIOLATION',
        JSON.stringify(pull.body).slice(0, 90));
    } else { note('no stock at the other branch to attempt a pull'); }

    if (ours) {
      // Sending OUT of your own branch is the legitimate direction.
      const push = await api('POST', '/api/transfers', {
        token: tBM, body: { from_branch_id: lagos.id, to_branch_id: other.id, stock_batch_id: ours.id, quantity: 1 },
      });
      check('...but CAN push stock out of their own branch', push.status === 201,
        `status=${push.status} ${JSON.stringify(push.body).slice(0, 90)}`);
      if (push.status === 201) {
        const recv = await api('POST', `/api/transfers/${push.body.id}/receive`, { token: tBM, body: {} });
        check('...and cannot RECEIVE it at the far end (that is the other branch\'s job)',
          recv.status === 403, `status=${recv.status} ${JSON.stringify(recv.body).slice(0, 90)}`);
      }
    } else { note('no non-controlled stock at the pinned branch to push'); }

    const seen = listOf((await api('GET', '/api/transfers', { token: tBM })).body);
    const unrelated = seen.filter((t) => t.from_branch_id !== lagos.id && t.to_branch_id !== lagos.id);
    check('the transfer list shows only movements involving their own branch',
      unrelated.length === 0, `${unrelated.length} unrelated transfers visible`);
  }

  console.log('\n=== E. THE MANAGER/OWNER BOUNDARY HOLDS ===');
  const promote = await api('PUT', `/api/users/${GM.user.id}`, { token: tGM, body: { role: 'OWNER' } });
  check('a manager cannot promote themselves to OWNER', promote.status >= 400,
    `status=${promote.status} ${JSON.stringify(promote.body).slice(0, 80)}`);
  const widen = await api('PUT', '/api/settings/manager-permissions', {
    token: tGM, body: { managers_can_void_sales: true },
  });
  check('a manager cannot widen what managers may do', widen.status === 403, `status=${widen.status}`);
  const tax = await api('PUT', '/api/settings/vat', { token: tGM, body: { vat_enabled: true, vat_rate_percent: 99 } });
  check('a manager cannot change the pharmacy\'s tax position', tax.status === 403, `status=${tax.status}`);
  const rates = await api('PUT', '/api/wht/rates/RENT', { token: tGM, body: { rate_percent: 1 } });
  check('a manager cannot change withholding-tax rates', rates.status === 403, `status=${rates.status}`);
  const portal = await api('GET', '/api/admin/settings', { token: tGM });
  check('a manager cannot open the vendor Admin Portal', portal.status === 403, `status=${portal.status}`);
  const plan = await api('PUT', '/api/admin/settings', { token: tGM, body: { max_branches: 99 } });
  check('...nor raise the plan limits they operate under', plan.status === 403, `status=${plan.status}`);

  console.log('\n=== F. THE MANAGER/MANAGER AND MANAGER/STAFF BOUNDARIES HOLD ===');
  const peer = listOf((await api('GET', '/api/users', { token: tGM })).body)
    .find((u) => u.role === 'MANAGER' && u.id !== GM.user.id);
  if (peer) {
    const peerEdit = await api('PUT', `/api/users/${peer.id}`, { token: tGM, body: { full_name: 'Renamed By Peer' } });
    check('a manager cannot edit a PEER manager', peerEdit.status === 403,
      `status=${peerEdit.status} ${JSON.stringify(peerEdit.body).slice(0, 80)}`);
    // A PIN is reset via PUT /users/:id { pin }, not a /reset-pin route — my
    // first version invented that endpoint and read its 404 as a refusal,
    // which would have "passed" for the wrong reason.
    const peerReset = await api('PUT', `/api/users/${peer.id}`, { token: tGM, body: { pin: '9999' } });
    check('...nor reset their PIN (that is a peer account takeover)',
      peerReset.status === 403, `status=${peerReset.status} ${JSON.stringify(peerReset.body).slice(0, 80)}`);
  } else { note('no peer manager found'); }

  // A manager override is a manager personally vouching for a flagged record.
  // It must never be anonymous or unexplained.
  // TRAP 18 — a probe that SKIPS is a probe that lies. This used to depend on
  // whatever attendance rows happened to exist, and silently checked NOTHING
  // when there were none. Seed a real flagged row instead, so the reason-
  // required rule is always exercised.
  let attList = listOf((await api('GET', `/api/attendance?branch_id=${lagos.id}`, { token: tGM })).body);
  if (!attList.length) {
    const lagosStaff = listOf((await api('GET', '/api/users', { token: tGM })).body)
      .find((u) => u.role === 'STAFF' && u.branch_id === lagos.id && u.is_active);
    if (lagosStaff) {
      const seedName = `attseed-${Date.now().toString(36)}`;
      const seeded = await api('POST', '/api/users', {
        token: tGM, body: { full_name: 'Attendance Seed', username: seedName, pin: '4321', role: 'STAFF', branch_id: lagos.id },
      });
      if (seeded.status === 201) {
        const st = (await api('POST', '/api/auth/login', { body: { username: seedName, pin: '4321' } })).body;
        if (st && st.token) {
          // No location supplied -> NO_LOCATION, which is a FLAGGED status, so
          // the record genuinely needs an override.
          await api('POST', '/api/attendance/clock-in', { token: st.token, body: { branch_id: lagos.id } });
        }
      }
    }
    attList = listOf((await api('GET', `/api/attendance?branch_id=${lagos.id}`, { token: tGM })).body);
  }
  check('an attendance record exists to exercise the override rules', attList.length > 0,
    'the reason-required checks below are meaningless without one');
  const noReason = await api('POST', `/api/attendance/${attList[0].id}/override`, { token: tGM, body: {} });
  check('an attendance override with NO reason is refused', noReason.status >= 400, `status=${noReason.status}`);
  const shortReason = await api('POST', `/api/attendance/${attList[0].id}/override`, { token: tGM, body: { reason: 'ok' } });
  check('...and a token 2-character reason is refused too', shortReason.status >= 400, `status=${shortReason.status}`);

  // BUG 71. Clock in with NO location so the record is genuinely FLAGGED —
  // an override only ever applies to a flagged record, and a manager signing
  // off their OWN flagged shift is one human on both sides of the approval.
  const selfOverride = await api('POST', '/api/attendance/clock-in', {
    token: tGM, body: { branch_id: lagos.id, device_id: 'probe-unregistered-device' },
  });
  if (selfOverride.status === 201) {
    const own = selfOverride.body;
    check('...and the manager\'s own shift really is flagged (so an override applies)',
      !!own.clock_in_status && own.clock_in_status !== 'ON_SITE', String(own.clock_in_status));
    const selfVouch = await api('POST', `/api/attendance/${own.id}/override`, {
      token: tGM, body: { reason: 'vouching for myself' },
    });
    check('a manager cannot approve their OWN flagged attendance (Bug 71)', selfVouch.status === 403,
      `status=${selfVouch.status} ${JSON.stringify(selfVouch.body).slice(0, 90)}`);
    check('...with a machine-readable code',
      selfVouch.body && selfVouch.body.code === 'SELF_OVERRIDE_FORBIDDEN',
      JSON.stringify(selfVouch.body).slice(0, 100));

    // ...but a DIFFERENT reviewer must still be able to sign it off, or the
    // guard has broken the feature instead of securing it.
    const byOwner = await api('POST', `/api/attendance/${own.id}/override`, {
      token: tO, body: { reason: 'Owner reviewed and confirmed this shift' },
    });
    check('...while the OWNER can still review that same record', byOwner.status === 200,
      `status=${byOwner.status} ${JSON.stringify(byOwner.body).slice(0, 90)}`);
    await api('POST', `/api/attendance/${own.id}/clock-out`, { token: tGM, body: { device_id: 'probe-unregistered-device' } });
  } else { note(`manager clock-in returned ${selfOverride.status} — self-override not exercised`); }

  console.log('\n=== G. THE OWNER\'S LEVERS ACTUALLY CONSTRAIN A REAL MANAGER ===');
  // A permission switch that does not bite is decoration.
  const perms0 = (await api('GET', '/api/settings/manager-permissions', { token: tO })).body;

  // 1. Expense approval — approval is what releases money.
  await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { managers_can_approve_expenses: false } });
  const exp = await api('POST', '/api/expenses', {
    token: tGM, body: { branch_id: lagos.id, category: 'diesel', amount: 500, description: 'lever probe' },
  });
  if (exp.status === 201) {
    const approve = await api('POST', `/api/expenses/${exp.body.id}/approve`, { token: tGM });
    check('withdrawing approval rights REFUSES a manager approval', approve.status === 403,
      `status=${approve.status} ${JSON.stringify(approve.body).slice(0, 80)}`);
    await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { managers_can_approve_expenses: true } });
    const approve2 = await api('POST', `/api/expenses/${exp.body.id}/approve`, { token: tGM });
    check('...and restoring it lets the same manager approve', approve2.status === 200,
      `status=${approve2.status} ${JSON.stringify(approve2.body).slice(0, 80)}`);
  } else { note(`could not create an expense for the approval lever: ${exp.status}`); }

  // 2. Price editing — this sets what a customer is charged.
  await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { managers_can_edit_prices: false } });
  const prods = listOf((await api('GET', '/api/products', { token: tGM })).body);
  const prod = prods.find((p) => !p.is_controlled);
  if (prod) {
    const priceOff = await api('PUT', `/api/products/${prod.id}/price-override/${lagos.id}`, {
      token: tGM, body: { default_selling_price: 999 },
    });
    check('withdrawing price rights REFUSES a manager price change', priceOff.status === 403,
      `status=${priceOff.status} ${JSON.stringify(priceOff.body).slice(0, 80)}`);
    await api('PUT', '/api/settings/manager-permissions', { token: tO, body: { managers_can_edit_prices: true } });
    const priceOn = await api('PUT', `/api/products/${prod.id}/price-override/${lagos.id}`, {
      token: tGM, body: { default_selling_price: 999 },
    });
    // 201 on first creation of an override row, 200 on a subsequent update —
    // both are correct. My first version pinned 200 and failed on a 201 that
    // was the API behaving properly.
    check('...and restoring it lets the same manager set a price',
      priceOn.status === 200 || priceOn.status === 201,
      `status=${priceOn.status} ${JSON.stringify(priceOn.body).slice(0, 80)}`);
    // The override must actually be the value asked for, not merely accepted.
    check('...and the price actually stored is the one requested',
      Number(priceOn.body && (priceOn.body.default_selling_price ?? priceOn.body.selling_price)) === 999,
      JSON.stringify(priceOn.body).slice(0, 120));
  } else { note('no non-controlled product for the price lever'); }

  // Restore the owner's original policy.
  await api('PUT', '/api/settings/manager-permissions', {
    token: tO,
    body: {
      managers_can_void_sales: !!perms0.managers_can_void_sales,
      managers_can_approve_expenses: !!perms0.managers_can_approve_expenses,
      managers_can_edit_prices: !!perms0.managers_can_edit_prices,
    },
  });

  console.log('\n=== H. A MANAGER IS AN EMPLOYEE, AND IS ATTRIBUTED AS ONE ===');
  // Unlike the vendor seat, a manager legitimately works the counter — but
  // every action must carry their name or the accountability reports are
  // fiction.
  const va = listOf((await api('GET', '/api/dashboard/void-audit', { token: tGM })).body);
  check('the void-rate report names every actor', va.every((r) => !!r.user_full_name),
    JSON.stringify(va).slice(0, 120));
  const tillOpen = await api('POST', '/api/till/open', { token: tGM, body: { branch_id: lagos.id, opening_float: 1000 } });
  check('a manager CAN open a till (they are a real employee)',
    tillOpen.status === 201 || tillOpen.status === 409, `status=${tillOpen.status}`);

  console.log('\n=== I. THE BOOKS SURVIVED EVERYTHING THIS PROBE DID ===');
  const tb = listOf((await api('GET', '/api/gl/trial-balance', { token: tGM })).body);
  const sum = tb.reduce((a, r) => { a.d += Number(r.total_debits || 0); a.c += Number(r.total_credits || 0); return a; }, { d: 0, c: 0 });
  check('debits still equal credits', Math.abs(Math.round((sum.d - sum.c) * 100) / 100) < 0.005,
    `debits=${sum.d.toFixed(2)} credits=${sum.c.toFixed(2)}`);

  console.log('\n' + '='.repeat(62));
  console.log(`MANAGER PROBE: ${pass} passed, ${fail} failed`);
  if (notes.length) { console.log('\nOBSERVATIONS:'); notes.forEach((n) => console.log('  - ' + n)); }
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
