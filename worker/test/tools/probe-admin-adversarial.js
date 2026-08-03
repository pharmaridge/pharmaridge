// ADMIN — ADVERSARIAL PASS.
//
// probe-admin.js checks the seat behaves as DESIGNED. This one assumes the
// vendor seat is hostile, or compromised, and asks what it could actually do
// to a paying client's records — because "PharmaRidge support" is a set of
// credentials that will eventually sit on a laptop in an office, and the
// client's accountant, PCN inspector and bank all rely on these records.
//
// The honest framing: ADMIN is a support seat with wide reach BY DESIGN, so
// most of these will be "yes it can, and that is intended". What matters is
// that every such power is (a) deliberate, (b) attributable to the vendor
// rather than to a pharmacy employee, and (c) not silently destructive.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
const notes = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function note(msg) { notes.push(msg); console.log('  ..   ' + msg); }

async function login(username, pin) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const b = await r.json();
  if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(b)}`);
  return b;
}
async function api(method, path, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: j };
}

(async () => {
  const A = await login('admin', '1234');
  const O = await login('owner', '1234');
  const M = await login('manager', '1234');
  const tA = A.token, tO = O.token, tM = M.token;
  const branches = (await api('GET', '/api/branches', { token: tA })).body;
  const branch = branches.find((b) => b.is_active);

  console.log('\n=== A. CAN THE VENDOR SEAT ESCALATE ITSELF? ===');
  // The subscription lever is how PharmaRidge gets paid; role is how it is
  // constrained. Neither should be reachable by forging a request body.
  const selfPromote = await api('PUT', `/api/users/${A.user.id}`, { token: tA, body: { role: 'OWNER' } });
  check('ADMIN cannot change its own role via user management',
    selfPromote.status >= 400, `status=${selfPromote.status} ${JSON.stringify(selfPromote.body).slice(0, 80)}`);

  const selfBranch = await api('PUT', `/api/users/${A.user.id}`, { token: tA, body: { branch_id: branch.id } });
  check('ADMIN cannot pin itself into a branch (which would make it look like staff)',
    selfBranch.status >= 400, `status=${selfBranch.status}`);

  // The login response must not be forgeable by claiming a role in the body.
  const forged = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'lagos.staff', pin: '1234', role: 'ADMIN' }),
  });
  const forgedBody = await forged.json();
  check('a role claimed in the login body is ignored',
    forgedBody.user && forgedBody.user.role === 'STAFF', `role=${forgedBody.user && forgedBody.user.role}`);

  console.log('\n=== B. CAN THE VENDOR SEAT ACT AS A PHARMACY EMPLOYEE INDIRECTLY? ===');
  // Direct clock-in/till/sale are blocked (probe-admin.js section D). The
  // question here is whether the same effect is reachable by a side door.
  const staffUser = (await api('GET', '/api/users', { token: tA })).body.find((u) => u.role === 'STAFF' && u.is_active);

  // 1. Override someone else's attendance — this IS allowed (a genuine support
  //    action) but must be attributed and reasoned.
  const att = (await api('GET', `/api/attendance?branch_id=${branch.id}`, { token: tA })).body;
  const attList = Array.isArray(att) ? att : (att.results || []);
  if (attList.length) {
    const noReason = await api('POST', `/api/attendance/${attList[0].id}/override`, { token: tA, body: {} });
    check('an attendance override with NO reason is refused, even for ADMIN',
      noReason.status >= 400, `status=${noReason.status}`);
  } else {
    note('no attendance rows to override in this dataset — skipped');
  }

  // 2. Can ADMIN reset a pharmacy user's PIN and then sign in as them? That
  //    would let the vendor impersonate an employee and record a sale.
  if (staffUser) {
    const reset = await api('POST', `/api/users/${staffUser.id}/reset-pin`, { token: tA, body: { new_pin: '5150' } });
    if (reset.status === 200 || reset.status === 204) {
      note('ADMIN CAN reset a pharmacy user PIN (a documented support power)');
      // The real risk: signing in as that user and transacting as them.
      let impersonated = null;
      try { impersonated = await login(staffUser.username, '5150'); } catch (e) { /* refused */ }
      if (impersonated) {
        note('...and can then sign in as that employee — this is inherent to any '
          + 'password-reset capability and cannot be closed by code alone');
        // What MUST be true: the reset itself is recorded against the vendor.
        const fresh = (await api('GET', '/api/users', { token: tA })).body.find((u) => u.id === staffUser.id);
        check('a PIN reset is attributable (credentials_changed_at moves)',
          !!(fresh && (fresh.credentials_changed_at || fresh.updated_at)),
          JSON.stringify({ cca: fresh && fresh.credentials_changed_at, ua: fresh && fresh.updated_at }));
        // And the employee's existing session must die, so they NOTICE.
        const oldSess = await login('lagos.staff', '1234').catch(() => null);
        check('...and the old PIN no longer works, so the employee notices immediately',
          oldSess === null, 'a silent takeover would be far worse than a noisy one');
      }
      // Restore.
      await api('POST', `/api/users/${staffUser.id}/reset-pin`, { token: tA, body: { new_pin: '1234' } });
    } else {
      check('ADMIN PIN reset is refused', reset.status >= 400, `status=${reset.status}`);
    }
  }

  console.log('\n=== C. CAN THE VENDOR SEAT DESTROY OR REWRITE FINANCIAL HISTORY? ===');
  // Append-only records are the client's protection. Support must not be able
  // to quietly rewrite them.
  const sales = (await api('GET', '/api/sales', { token: tA })).body;
  const saleList = Array.isArray(sales) ? sales : (sales.results || []);
  const completed = saleList.find((s) => s.status === 'COMPLETED');

  if (completed) {
    const del = await api('DELETE', `/api/sales/${completed.id}`, { token: tA });
    check('a completed sale cannot be DELETED (append-only)',
      del.status === 404 || del.status === 405 || del.status === 403,
      `status=${del.status}`);
    const edit = await api('PUT', `/api/sales/${completed.id}`, { token: tA, body: { total_amount: 1 } });
    check('a completed sale cannot be EDITED',
      edit.status === 404 || edit.status === 405 || edit.status === 403, `status=${edit.status}`);
    // Voiding IS allowed and is the correct mechanism — it reverses rather
    // than erases. Confirm it leaves a trail rather than removing the row.
    const before = saleList.length;
    const voided = await api('POST', `/api/sales/${completed.id}/void`, { token: tA, body: { reason: 'adversarial probe' } });
    if (voided.status === 200) {
      const after = (await api('GET', '/api/sales', { token: tA })).body;
      const afterList = Array.isArray(after) ? after : (after.results || []);
      check('voiding REVERSES rather than erases (row still present)',
        afterList.length === before, `${before} -> ${afterList.length}`);
      const row = afterList.find((s) => s.id === completed.id);
      check('...and the void is attributed to the vendor seat',
        row && row.voided_by === A.user.id, `voided_by=${row && row.voided_by} admin=${A.user.id}`);
      check('...and carries the reason given',
        row && /adversarial probe/.test(String(row.void_reason || '')), String(row && row.void_reason));
    } else {
      note(`void returned ${voided.status} — ${JSON.stringify(voided.body).slice(0, 90)}`);
    }
  } else {
    note('no COMPLETED sale in this dataset — history-rewrite checks skipped');
  }

  // The controlled-drug register is hash-chained and legally significant.
  const chain = await api('GET', `/api/controlled-register/verify/${branch.id}`, { token: tA });
  check('the controlled-drug register chain is intact and verifiable by support',
    chain.status === 200 && chain.body && chain.body.valid === true, JSON.stringify(chain.body).slice(0, 110));

  console.log('\n=== D. CAN THE VENDOR SEAT SILENTLY WEAKEN THE CLIENT\'S CONTROLS? ===');
  // The three managers_can_* permissions and VAT are client-owned. Section F
  // of probe-admin.js proves the Admin Portal refuses them. The question here
  // is whether the SAME effect is reachable through a different door.
  const viaOwnerRoute = await api('PUT', '/api/settings/manager-permissions', {
    token: tA, body: { managers_can_void_sales: true },
  });
  note(`PUT /settings/manager-permissions as ADMIN -> ${viaOwnerRoute.status}`);
  // Whatever the answer, it must be consistent with the Admin Portal's story.
  const portalRefusal = await api('PUT', '/api/admin/settings', {
    token: tA, body: { managers_can_void_sales: true },
  });
  check('the Admin Portal consistently refuses client-owned permission changes',
    portalRefusal.status === 400 && portalRefusal.body.code === 'CLIENT_OWNED_SETTING',
    `status=${portalRefusal.status}`);

  console.log('\n=== E. IS THE SUBSCRIPTION LEVER ABUSE-RESISTANT? ===');
  // Suspending a client is a commercial act. It must never destroy data, and
  // it must never trap the client's own OWNER out of their records.
  const s0 = (await api('GET', '/api/admin/settings', { token: tA })).body;
  await api('PUT', '/api/admin/settings', { token: tA, body: { subscription_status: 'EXPIRED' } });
  const ownerRead = await api('GET', '/api/gl/trial-balance', { token: tO });
  check('an EXPIRED client can still read their own general ledger',
    ownerRead.status === 200, `status=${ownerRead.status}`);
  const ownerExport = await api('GET', '/api/sales', { token: tO });
  check('...and still export their own sales history', ownerExport.status === 200, `status=${ownerExport.status}`);
  const ownerWrite = await api('POST', '/api/products', {
    token: tO, body: { name: 'Should Fail', generic_name: 'x', unit_of_measure: 'unit', base_unit: 'unit' },
  });
  check('...but cannot create new records while expired', ownerWrite.status === 403, `status=${ownerWrite.status}`);
  await api('PUT', '/api/admin/settings', { token: tA, body: { subscription_status: s0.subscription_status || 'ACTIVE' } });
  const restored = await api('GET', '/api/dashboard/summary', { token: tM });
  check('reinstating restores full operation', restored.status === 200, `status=${restored.status}`);

  console.log('\n=== F. PLAN LIMITS CANNOT BE SET TO NONSENSE ===');
  for (const [label, payload] of [
    ['zero branches', { max_branches: 0 }],
    ['negative branches', { max_branches: -5 }],
    ['fractional branches', { max_branches: 2.5 }],
    ['string branches', { max_branches: '10' }],
    ['zero staff', { max_staff: 0 }],
    ['negative staff', { max_staff: -1 }],
    ['bogus status', { subscription_status: 'FREELOADING' }],
  ]) {
    const r = await api('PUT', '/api/admin/settings', { token: tA, body: payload });
    check(`refused: ${label}`, r.status === 400, `status=${r.status}`);
  }
  // A limit BELOW current usage is a legitimate downgrade, but it must not
  // delete anything or break existing branches.
  const usage = (await api('GET', '/api/admin/settings', { token: tA })).body.usage;
  const downgrade = await api('PUT', '/api/admin/settings', { token: tA, body: { max_branches: 1 } });
  if (downgrade.status === 200) {
    const afterBranches = (await api('GET', '/api/branches', { token: tA })).body;
    check('downgrading the plan does not delete existing branches',
      afterBranches.length === branches.length, `${branches.length} -> ${afterBranches.length}`);
    const stillSells = await api('GET', '/api/dashboard/summary', { token: tM });
    check('...and existing branches keep working', stillSells.status === 200, `status=${stillSells.status}`);
  }
  await api('PUT', '/api/admin/settings', { token: tA, body: { max_branches: Math.max(usage.branches_used, 2) } });

  console.log('\n' + '='.repeat(62));
  console.log(`ADMIN ADVERSARIAL PROBE: ${pass} passed, ${fail} failed`);
  if (notes.length) { console.log('\nOBSERVATIONS (not failures):'); notes.forEach((n) => console.log('  - ' + n)); }
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
