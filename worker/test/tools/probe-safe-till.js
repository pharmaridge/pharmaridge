// probe-safetill — BUG 116: cash moved between the safe and the drawer was
// invisible to the till.
//
// HOW IT WAS FOUND, because the route matters. For several rounds I reported
// probe-accounting as "intermittent — cross-probe seed contamination, passes
// on a fresh DB" and moved on. Sitting down to actually fix the harness
// produced two of my own errors first (a wrong field name, then a probe that
// drained the safe it depended on) — and behind those was a real product
// defect that the intermittency had been hiding the whole time.
//
// THE DEFECT. computeExpectedCash() counts every other door cash uses: sale
// payments, debtor repayments, retained change, cash expenses, supplier
// payments. The one movement that exists ONLY to change how much is in the
// drawer — a safe <-> till transfer — was not counted at all.
//
// Consequences, both live-reproduced:
//   * A manager moves N30,000 from the safe into the till. The drawer's
//     expected cash does not move, so the cashier CANNOT SPEND IT: a N1,000
//     purchase is refused with CASH_EXPENSE_EXCEEDS_DRAWER against a drawer
//     physically holding N30,033.
//   * At close of day the count shows a N30,000 OVERAGE for money the manager
//     put in deliberately, and that phantom difference posts permanently to
//     CASH_OVER_SHORT.
//
// This is the whole reason a branch safe exists — take the day's takings out
// of an open drawer, refill the drawer for change — and both halves were
// broken.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

(async () => {
  const lg = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', pin: '1234' }),
  })).json();
  const H = { 'content-type': 'application/json', authorization: `Bearer ${lg.token}` };
  const get = async (p) => JSON.parse(await (await fetch(BASE + p, { headers: H })).text());
  const post = async (p, body) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
    return { status: r.status, text: await r.text() };
  };
  const L = (x) => (x && x.results) ? x.results : x;

  const br = L(await get('/api/branches')).filter((b) => b.is_active)[0];
  const openTill = async () => {
    const tills = L(await get(`/api/till?branch_id=${br.id}`));
    return Array.isArray(tills) ? tills.find((t) => t.status === 'OPEN') : null;
  };
  // This probe CLOSES the till at the end, so a second run must be able to
  // open a fresh one — and any other probe that follows it needs a funded
  // drawer, not the closed one this left behind. Open unconditionally (a
  // 409 when one is already open is fine and ignored).
  await post('/api/till/open', { branch_id: br.id, opening_float: 5000 });
  // The live figure comes from GET /api/till/:id/expected. There is no
  // GET /api/till/:id, and the LIST row carries expected_closing_cash which
  // is only populated once the till has been CLOSED — reading either of those
  // gives NaN on an open session. (My first version did exactly that.)
  const expected = async () => {
    const t = await openTill();
    if (!t) return null;
    const r = await get(`/api/till/${t.id}/expected`);
    const v = r.expected_closing_cash;
    return v == null ? null : Number(v);
  };

  console.log('\n=== MONEY MOVED INTO THE DRAWER SHOWS UP IN THE DRAWER ===');
  {
    const dep = await post('/api/safe/movements', {
      branch_id: br.id, entry_type: 'DEPOSIT', amount: 50000, reason: 'probe: fund the safe',
    });
    check('the safe can be funded', dep.status === 200 || dep.status === 201, `${dep.status} ${dep.text.slice(0, 90)}`);

    const before = await expected();
    check('the open till reports an expected-cash figure', before != null && !Number.isNaN(before), String(before));

    // TILL_TRANSFER carries direction in the SIGN (trap #95): NEGATIVE moves
    // cash out of the safe and into the drawer.
    const top = await post('/api/safe/movements', {
      branch_id: br.id, entry_type: 'TILL_TRANSFER', amount: -20000, reason: 'probe: refill the drawer for change',
    });
    check('cash can be moved from the safe into the till',
      top.status === 200 || top.status === 201, `${top.status} ${top.text.slice(0, 90)}`);

    const after = await expected();
    check('...and the drawer\'s expected cash RISES by exactly that amount',
      Math.abs((after - before) - 20000) < 0.005,
      `before ${before}, after ${after}, difference ${after - before}`);
  }

  console.log('\n=== AND THE CASHIER CAN ACTUALLY SPEND IT ===');
  {
    // The user-visible half of the bug: money in the drawer that the drawer
    // does not know about cannot be used.
    const exp = await post('/api/expenses', {
      branch_id: br.id, category: 'TRANSPORT', description: 'probe: spend from the refilled drawer',
      amount: 15000, payment_method: 'CASH',
    });
    check('a purchase within the refilled drawer is allowed',
      exp.status === 201, `${exp.status} ${exp.text.slice(0, 130)}`);
  }

  console.log('\n=== MONEY MOVED OUT OF THE DRAWER LEAVES THE DRAWER ===');
  {
    const before = await expected();
    // POSITIVE moves cash drawer -> safe: taking the takings out of an open
    // till, which is the other half of why the safe exists.
    const away = await post('/api/safe/movements', {
      branch_id: br.id, entry_type: 'TILL_TRANSFER', amount: 10000, reason: 'probe: bank the takings',
    });
    check('cash can be moved from the till into the safe',
      away.status === 200 || away.status === 201, `${away.status} ${away.text.slice(0, 90)}`);
    const after = await expected();
    check('...and the drawer\'s expected cash FALLS by exactly that amount',
      Math.abs((before - after) - 10000) < 0.005,
      `before ${before}, after ${after}, difference ${before - after}`);
  }

  console.log('\n=== BUG 117: THE DRAWER CANNOT BE SWEPT NEGATIVE EITHER ===');
  {
    // Exposed by fixing Bug 116. Once a transfer actually moved the drawer's
    // figure, it became possible to move MORE out than the drawer holds:
    // N999,999 swept from a till holding N29,277 was accepted and left
    // expected cash at -N970,721.
    //
    // A cash EXPENSE larger than the drawer has been refused since Bug 96.
    // A sweep into the safe is the same physical act, so the protection could
    // be walked around simply by choosing the other verb.
    const before = await expected();
    const over = await post('/api/safe/movements', {
      branch_id: br.id, entry_type: 'TILL_TRANSFER', amount: before + 500000,
      reason: 'probe: attempt to sweep more than the drawer holds',
    });
    check('sweeping more than the drawer holds is refused',
      over.status === 400 && /TILL_TRANSFER_EXCEEDS_DRAWER/.test(over.text),
      `${over.status} ${over.text.slice(0, 110)}`);
    const after = await expected();
    check('...and the drawer is left exactly as it was',
      Math.abs(after - before) < 0.005, `before ${before}, after ${after}`);
    check('the expected figure never goes negative', after >= -0.005, String(after));

    // A guard that also blocks legitimate work is not a fix.
    const fine = await post('/api/safe/movements', {
      branch_id: br.id, entry_type: 'TILL_TRANSFER', amount: Math.floor(before / 2),
      reason: 'probe: an ordinary end-of-day sweep must still work',
    });
    check('an ordinary sweep of part of the drawer still works',
      fine.status === 200 || fine.status === 201, `${fine.status} ${fine.text.slice(0, 100)}`);
  }

  console.log('\n=== CLOSING THE TILL AGREES WITH THE PHYSICAL COUNT ===');
  {
    // The other user-visible half: a manager refills the drawer, the cashier
    // counts what is really there, and the shift must close clean rather than
    // reporting a phantom overage.
    const t = await openTill();
    const exp = await expected();
    // The owner did not open this till, and force-closing someone else's
    // drawer requires a stated reason — a correct guard, not a defect. Supply
    // one rather than weakening the check.
    const close = await post(`/api/till/${t.id}/close`, {
      counted_closing_cash: exp,
      force_reason: 'probe: verifying a refilled drawer closes without a phantom discrepancy',
    });
    check('counting exactly the expected figure closes the till', close.status === 200,
      `${close.status} ${close.text.slice(0, 110)}`);
    if (close.status === 200) {
      const body = JSON.parse(close.text);
      const disc = Number(body.discrepancy != null ? body.discrepancy : (body.till && body.till.discrepancy));
      check('...with NO discrepancy — no phantom overage for a deliberate refill',
        Math.abs(disc) < 0.005, `discrepancy ${disc}`);
    }
  }

  console.log('\n=== LEAVE THE BRANCH USABLE FOR WHATEVER RUNS NEXT ===');
  {
    // A probe that closes the till and walks away breaks every cash probe
    // after it — which is precisely the "seed contamination" this whole round
    // set out to eliminate. Re-open a funded drawer on the way out.
    const reopened = await post('/api/till/open', { branch_id: br.id, opening_float: 5000 });
    check('a fresh till is left open for the next probe',
      reopened.status === 201 || reopened.status === 409,
      `${reopened.status} ${reopened.text.slice(0, 90)}`);
    const t = await openTill();
    if (t) {
      const have = Number(await expected()) || 0;
      if (have < 40000) {
        await post('/api/safe/movements', {
          branch_id: br.id, entry_type: 'DEPOSIT', amount: 60000, reason: 'probe teardown: leave the safe funded',
        });
        const top = await post('/api/safe/movements', {
          branch_id: br.id, entry_type: 'TILL_TRANSFER', amount: -(40000 - have),
          reason: 'probe teardown: leave the drawer funded',
        });
        check('the drawer is left funded for the next probe',
          top.status === 200 || top.status === 201, `${top.status} ${top.text.slice(0, 90)}`);
      }
    }
  }

  console.log('\n=== AND THE BOOKS STILL BALANCE ===');
  {
    const tb = await get('/api/gl/trial-balance');
    const sum = tb.reduce((a, r) => a + (r.total_debits - r.total_credits), 0);
    check('the trial balance balances after moving cash both ways',
      Math.abs(sum) < 0.005, `sum(dr-cr)=${sum}`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
