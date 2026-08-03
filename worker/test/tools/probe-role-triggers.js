// probe-roletriggers — "is every trigger attached to each role represented
// and functional?"
//
// This is a DIFFERENT question from the route-reachability scan already in
// audit.golive.js. That one asks "does any endpoint exist with no UI at all".
// This one asks, per ROLE:
//
//   1. Does every nav item that role can SEE actually open, for them?
//   2. Is every nav item hidden from them genuinely refused by the SERVER
//      too — i.e. is the menu telling the truth, or just hiding a door that
//      is still unlocked?
//   3. Does every screen they can open actually LOAD for them (no blank
//      page, no permission wall behind a link they were offered)?
//
// A menu that hides something the server allows is a capability with no door
// (trap #83). A menu that OFFERS something the server refuses is worse: the
// user clicks it and is told off for doing what they were invited to do.
//
// Requires: bash test/devserver.sh 9001 && node test/tools/seed-scenarios.js
const puppeteer = require('puppeteer');
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';
const sl = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// The four roles this product ships, and an account for each. `admin` is the
// vendor support seat, deliberately included: it has powers nobody else has
// and restrictions nobody else has (it may never move cash).
const ROLES = [
  { label: 'OWNER (proprietor)', user: 'owner' },
  { label: 'GENERAL MANAGER (org-wide)', user: 'c.gm' },
  { label: 'BRANCH MANAGER (pinned)', user: 'lagos.mgr' },
  { label: 'STAFF (counter)', user: 'lagos.staff' },
  { label: 'ADMIN (vendor support)', user: 'admin' },
];

async function signIn(browser, username, pin = '1234') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('dialog', async (d) => { await d.accept(); });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate((u, p) => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('login-username', u); set('login-pin', p);
  }, username, pin);
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await page.waitForFunction(() => typeof State !== 'undefined' && !!State.getSession(), { timeout: 15000 });
  await sl(2200);
  return { ctx, page };
}

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  for (const role of ROLES) {
    console.log(`\n=== ${role.label} ===`);
    let page;
    try { ({ page } = await signIn(browser, role.user)); }
    catch (e) { check(`${role.user} can sign in`, false, e.message.slice(0, 80)); continue; }
    check(`${role.user} can sign in`, true);

    // What the menu offers this person, and what it hides.
    const nav = await page.evaluate(() => {
      const out = { visible: [], hidden: [] };
      document.querySelectorAll('#sidebar a[data-nav]').forEach((a) => {
        const shown = a.offsetParent !== null && getComputedStyle(a).display !== 'none';
        (shown ? out.visible : out.hidden).push(a.getAttribute('data-nav'));
      });
      return out;
    });
    check(`the menu offers this role something to do`, nav.visible.length > 0,
      `visible=${nav.visible.length} hidden=${nav.hidden.length}`);
    console.log(`       visible: ${nav.visible.join(', ')}`);
    if (nav.hidden.length) console.log(`       hidden : ${nav.hidden.join(', ')}`);

    // 1 + 3. EVERY offered destination must actually open for them.
    const broken = [];
    for (const dest of nav.visible) {
      await page.evaluate((d) => { location.hash = `#/${d}`; }, dest);
      await sl(1100);
      const state = await page.evaluate(() => {
        const v = document.getElementById('view') || document.querySelector('.view') || document.body;
        const text = (v.innerText || '').trim();
        return {
          len: text.length,
          // MY FIRST VERSION OF THIS WAS WRONG and reported four healthy
          // screens as refusals: it searched the first 400 characters for
          // words like "permission", which appear in ordinary page copy
          // ("An off-site clock-in needs permission", "Cashier Spending
          // Allowance"). A permission WALL is a short page that says only
          // that; a working screen is long and merely mentions the words.
          // Assert the outcome — did the screen render — not a keyword.
          refused: text.length < 220
            && /only (managers|owners)|do not have permission|Admin Portal access required/i.test(text),
          head: text.slice(0, 70).replace(/\s+/g, ' '),
        };
      });
      if (state.len < 40 || state.refused) broken.push(`${dest}(${state.refused ? 'refused' : 'empty'}: ${state.head})`);
    }
    check('every destination the menu offers actually opens', broken.length === 0,
      broken.slice(0, 3).join(' | '));

    // 2. Anything HIDDEN from them must also be refused by the server. The
    //    menu must not be the only lock on the door.
    // Only endpoints whose SCREEN being hidden implies the DATA is barred.
    //
    // products and suppliers are deliberately NOT here. Both return 200 to a
    // cashier by design and that is correct: a cashier needs the product
    // catalogue to sell at all, and /suppliers returns them an id+name
    // PROJECTION so the purchase-order dropdown works without exposing
    // contact details. Their SCREENS are manager-only (editing a price,
    // reading a supplier's terms); the read is not. My first version of this
    // check treated "hidden menu item" as "must 403" and reported both as
    // leaks — the assumption was wrong, not the application.
    const HIDDEN_TO_API = {
      users: '/api/users',
      accounting: '/api/gl/trial-balance',
      plan: '/api/plan',
      admin: '/api/admin/settings',
    };
    const leaks = [];
    for (const dest of nav.hidden) {
      const apiPath = HIDDEN_TO_API[dest];
      if (!apiPath) continue;
      const status = await page.evaluate(async (p) => {
        try { const r = await fetch(p, { headers: { authorization: 'Bearer ' + JSON.parse(localStorage.getItem('gl_pms_session')).token } }); return r.status; }
        catch (e) { return 0; }
      }, apiPath);
      if (status >= 200 && status < 300) leaks.push(`${dest} -> ${apiPath} returned ${status}`);
    }
    check('nothing hidden from the menu is left unlocked on the server',
      leaks.length === 0, leaks.join(' | '));

    await page.close();
  }

  // ---------------------------------------------------------------------
  console.log('\n=== ROLE-SPECIFIC TRIGGERS THAT MUST EXIST AND WORK ===');
  // ---------------------------------------------------------------------
  {
    // Spot-check the powers each role is DEFINED by, rather than only the
    // nav. These are the controls a pharmacy actually buys the product for.
    const api = async (user, method, path, body) => {
      const lg = await (await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, pin: '1234' }),
      })).json();
      const r = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${lg.token}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, text: await r.text() };
    };

    // OWNER: the only role that may change tax and permission settings.
    const ownerVat = await api('owner', 'PUT', '/api/settings/vat', { vat_enabled: false, vat_rate_percent: 7.5 });
    check('OWNER can set VAT', ownerVat.status === 200, `${ownerVat.status}`);
    const mgrVat = await api('lagos.mgr', 'PUT', '/api/settings/vat', { vat_enabled: true, vat_rate_percent: 7.5 });
    check('...and a Branch Manager cannot', mgrVat.status === 403, `${mgrVat.status}`);

    // GENERAL MANAGER: every branch. BRANCH MANAGER: exactly one.
    // Branch scoping is enforced on the ROWS a manager can act on, not on the
    // branch LIST — both roles legitimately see the estate's branch names (a
    // Branch Manager needs them to raise a transfer). My first version
    // compared /api/branches counts, found 8 vs 8, and called it a failure;
    // the meaningful comparison is who they can SEE AND MANAGE.
    const gmUsers = await api('c.gm', 'GET', '/api/users');
    const bmUsers = await api('lagos.mgr', 'GET', '/api/users');
    const gmU = (JSON.parse(gmUsers.text).results || JSON.parse(gmUsers.text));
    const bmU = (JSON.parse(bmUsers.text).results || JSON.parse(bmUsers.text));
    const bmBranches = new Set(bmU.map((u) => u.branch_id).filter(Boolean));
    check('a General Manager sees staff across the estate',
      new Set(gmU.map((u) => u.branch_id).filter(Boolean)).size > 1,
      `branches=${new Set(gmU.map((u) => u.branch_id).filter(Boolean)).size}`);
    check('a Branch Manager sees staff from exactly ONE branch',
      bmBranches.size === 1, `branches=${bmBranches.size} users=${bmU.length}`);
    check('...and strictly fewer people than the General Manager',
      bmU.length < gmU.length, `bm=${bmU.length} gm=${gmU.length}`);

    // STAFF: may sell and may record an expense, may NOT list all expenses.
    const staffExpense = await api('lagos.staff', 'GET', '/api/expenses');
    check('STAFF cannot browse every expense', staffExpense.status === 403, `${staffExpense.status}`);

    // ADMIN: raises the plan ceiling, and may NEVER move cash.
    const adminPlan = await api('admin', 'GET', '/api/admin/settings');
    check('ADMIN can read the plan/settings portal', adminPlan.status === 200, `${adminPlan.status}`);
    const ownerPortal = await api('owner', 'GET', '/api/admin/settings');
    check('...and the OWNER cannot (only the vendor raises the ceiling)',
      ownerPortal.status === 403, `${ownerPortal.status}`);
    const blist = JSON.parse((await api('owner', 'GET', '/api/branches')).text);
    const bid = (blist.results || blist)[0].id;
    const adminCash = await api('admin', 'POST', '/api/safe/movements',
      { branch_id: bid, entry_type: 'DEPOSIT', amount: 1000, reason: 'probe: vendor must not move cash' });
    check('ADMIN is refused outright from moving a client\'s cash',
      adminCash.status === 403 && /VENDOR_CANNOT_MOVE_CASH/.test(adminCash.text),
      `${adminCash.status} ${adminCash.text.slice(0, 90)}`);
  }

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
