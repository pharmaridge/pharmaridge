// BUG 91 REGRESSION PROBE — a guard must read a flag exactly as the write does.
//
// Every deactivation guard is exercised through BOTH JSON shapes that mean
// "off": the boolean `false` the SPA sends, and the number `0` that every
// integration, curl call and round-tripped record sends. Before the fix the
// number bypassed three guards while the write went through anyway.
//
// Asserts INTENT (the guard fired / the side effect happened), never the
// literal comparison in the source — pinning source text broke on a correct
// fix once already (Bug 43).
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✅ ' + m); };
const bad = (m) => { fail++; console.log('  ❌ ' + m); };

async function req(m, p, { token, body } = {}) {
  const h = { 'content-type': 'application/json' };
  if (token) h.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null;
  try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
}
const login = async (u, pin = '1234') => await req('POST', '/api/auth/login', { body: { username: u, pin } });
const L = b => (Array.isArray(b) ? b : []);

(async () => {
  const ownerRes = await login('owner');
  if (ownerRes.status !== 200) { console.log('cannot log in — seed first'); process.exit(3); }
  const owner = ownerRes.body.token, ownerUser = ownerRes.body.user;
  const admin = (await login('admin')).body.token;

  // ---- A. THE SOLE OWNER CANNOT DEACTIVATE THEMSELVES, BY EITHER SHAPE ----
  console.log('\n=== A. LAST-OWNER LOCKOUT (both JSON shapes) ===');
  const users = L((await req('GET', '/api/users', { token: owner })).body);
  const activeOwners = users.filter(u => u.role === 'OWNER' && u.is_active);
  if (activeOwners.length !== 1) { bad(`expected exactly 1 active owner to test with, found ${activeOwners.length}`); }
  else ok('fixture: exactly one active Owner, so this IS the last-owner case');

  for (const [shape, value] of [['boolean false', false], ['number 0', 0], ['string "0"', '0'], ['string "false"', 'false']]) {
    const r = await req('PUT', `/api/users/${ownerUser.id}`, { token: owner, body: { is_active: value } });
    if (r.status === 400 && r.body && r.body.code === 'LAST_OWNER_PROTECTED') {
      ok(`sole Owner deactivation refused via ${shape} (LAST_OWNER_PROTECTED)`);
    } else {
      bad(`sole Owner deactivation via ${shape} returned ${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
    }
    // Whatever happened, the owner must still be able to sign in.
    const still = await login('owner');
    if (still.status === 200) ok(`  Owner can still sign in after the ${shape} attempt`);
    else bad(`  OWNER IS LOCKED OUT after the ${shape} attempt — login ${still.status}`);
  }

  // ---- B. DEACTIVATION AUTO-CLOSES THE OPEN SHIFT, BY EITHER SHAPE -------
  console.log('\n=== B. DEPARTING EMPLOYEE\'S SHIFT AUTO-CLOSES (both shapes) ===');
  const openShifts = async (u) => L((await req('GET', `/api/attendance?branch_id=${u.branch_id}&limit=500`, { token: owner })).body)
    .filter(a => a.user_id === u.id && !a.clock_out_at).length;

  const candidates = users.filter(u => u.role === 'STAFF' && u.is_active && u.branch_id);
  const pairs = [['boolean false', false], ['number 0', 0]];
  for (let i = 0; i < pairs.length; i++) {
    const [shape, value] = pairs[i];
    const victim = candidates[i];
    if (!victim) { bad(`no staff fixture available for the ${shape} case`); continue; }
    // Make sure they really are clocked in — a guard that "passes" because
    // there was nothing to close proves nothing (trap #62).
    const vTok = (await login(victim.username)).body?.token;
    if (vTok) await req('POST', '/api/attendance/clock-in', { token: vTok, body: { branch_id: victim.branch_id } });
    const before = await openShifts(victim);
    if (before < 1) { bad(`${victim.username} has no open shift, so this case would prove nothing`); continue; }
    ok(`${victim.username} has ${before} open shift before deactivation`);
    const r = await req('PUT', `/api/users/${victim.id}`, { token: owner, body: { is_active: value } });
    const after = await openShifts(victim);
    if (r.status === 200 && after === 0) ok(`  deactivation via ${shape} auto-closed the shift`);
    else bad(`  deactivation via ${shape}: status ${r.status}, open shifts ${before} -> ${after} (expected 0)`);
  }

  // ---- C. BRANCH CLOSURE WARNS ABOUT WORK IN FLIGHT, BY EITHER SHAPE ----
  console.log('\n=== C. BRANCH CLOSURE WARNING (both shapes) ===');
  const branches = L((await req('GET', '/api/branches', { token: owner })).body).filter(b => b.is_active);
  const withWork = [];
  for (const b of branches) {
    const tills = L((await req('GET', '/api/till?branch_id=' + b.id, { token: owner })).body).filter(t => t.status === 'OPEN');
    if (tills.length) withWork.push(b);
    if (withWork.length === 2) break;
  }
  if (withWork.length < 2) bad(`need 2 branches with an open till to compare shapes, found ${withWork.length}`);
  else {
    ok('fixture: two branches each with an open till (real work in flight)');
    for (let i = 0; i < 2; i++) {
      const [shape, value] = pairs[i];
      const r = await req('PUT', `/api/branches/${withWork[i].id}`, { token: owner, body: { is_active: value } });
      const w = r.body && r.body.closure_warning;
      if (r.status === 200 && w && w.code === 'BRANCH_CLOSED_WITH_WORK_IN_FLIGHT' && w.items && w.items.length) {
        ok(`  closing via ${shape} warned about ${w.items.length} unfinished item(s)`);
      } else {
        bad(`  closing via ${shape}: status ${r.status}, closure_warning ${w ? 'present but empty' : 'ABSENT'}`);
      }
    }
  }

  // ---- D. TRUE STILL MEANS TRUE, AND ABSENT STILL MEANS ABSENT ----------
  console.log('\n=== D. THE FIX MUST NOT OVER-REACH ===');
  // Reactivating must work by either shape.
  const reTarget = candidates[0];
  for (const [shape, value] of [['boolean true', true], ['number 1', 1]]) {
    await req('PUT', `/api/users/${reTarget.id}`, { token: admin, body: { is_active: 0 } });
    const r = await req('PUT', `/api/users/${reTarget.id}`, { token: admin, body: { is_active: value } });
    if (r.status === 200 && r.body.is_active === 1) ok(`reactivation via ${shape} works`);
    else bad(`reactivation via ${shape}: ${r.status} is_active=${r.body && r.body.is_active}`);
  }
  // A PUT that never mentions is_active must NOT be read as a deactivation,
  // and must not close anybody's shift.
  {
    // The fixture must genuinely have an OPEN shift, or "the shift was not
    // closed" is vacuously true and proves nothing (trap #62). Search for a
    // still-active staff member who is actually clocked in, clocking one in
    // if needed, and FAIL rather than pass if none can be arranged.
    let t = null, before = 0;
    for (const cand of candidates.slice(2).concat(candidates)) {
      const row0 = L((await req('GET', '/api/users', { token: owner })).body).find(u => u.id === cand.id);
      if (!row0 || !row0.is_active) continue;
      const tTok = (await login(cand.username)).body?.token;
      if (!tTok) continue;
      await req('POST', '/api/attendance/clock-in', { token: tTok, body: { branch_id: cand.branch_id } });
      const n = await openShifts(cand);
      if (n > 0) { t = cand; before = n; break; }
    }
    if (!t) { bad('could not arrange an active, clocked-in staff fixture — the no-op PUT case would prove nothing'); }
    else {
      ok(`fixture: ${t.username} is active with ${before} open shift`);
      const r = await req('PUT', `/api/users/${t.id}`, { token: owner, body: { job_title: 'Relief Cashier' } });
      const after = await openShifts(t);
      const row = L((await req('GET', '/api/users', { token: owner })).body).find(u => u.id === t.id);
      if (r.status === 200 && row && row.is_active === 1) ok('a PUT with no is_active leaves the account active');
      else bad(`a PUT with no is_active changed activity: status ${r.status}, is_active=${row && row.is_active}`);
      if (after === before) ok(`a PUT with no is_active left the open shift alone (${before} -> ${after})`);
      else bad(`a PUT with no is_active closed a shift: ${before} -> ${after}`);
    }
  }
  // Garbage in the field must not be read as an instruction either way.
  {
    const t = candidates[3] || candidates[0];
    const r = await req('PUT', `/api/users/${t.id}`, { token: owner, body: { is_active: 'maybe' } });
    const row = L((await req('GET', '/api/users', { token: owner })).body).find(u => u.id === t.id);
    if (r.status < 500) ok(`a nonsense is_active value did not crash the endpoint (${r.status})`);
    else bad(`a nonsense is_active value produced ${r.status}`);
    if (row && row.is_active === 1) ok('a nonsense is_active value did not deactivate the account');
    else bad(`a nonsense is_active value left is_active=${row && row.is_active}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
