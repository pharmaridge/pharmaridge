// probe-branding — BUG 111: every printed document showed OUR name, not the
// client's, on every white-labelled deployment since day one.
//
// `const Branding = ...` at the top level of a classic script creates a script
// binding, NOT a property on `window`. Four modules guard optional access as
// `(window.Branding && Branding.displayName())`, a defensive idiom that is
// always FALSE here — so the guarded branch never ran and the fallback string
// 'PharmaRidge' was used forever. Nothing errored; the fallback looked
// deliberate.
//
// Tested in a real browser against the real renderers, because the defect is
// entirely a runtime-scope question: reading the source shows a guard that
// looks correct.
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

(async () => {
  const branding = await (await fetch(`${BASE}/api/branding`)).json();
  check('this deployment has a client business name to test with',
    !!branding.business_name, JSON.stringify(branding));
  const CLIENT = branding.business_name;

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 950 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('login-username', 'owner'); set('login-pin', '1234');
  });
  await page.evaluate(() => document.getElementById('login-form')
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !!localStorage.getItem('gl_pms_session'), { timeout: 25000 });
  await page.waitForFunction(() => typeof Branding !== 'undefined' && !!Branding.get(), { timeout: 20000 });
  await sl(1500);

  console.log('\n=== THE SHARED MODULES ARE REACHABLE THE WAY CALLERS EXPECT ===');
  {
    // The root cause, asserted directly: the guards must be TRUE.
    const reach = await page.evaluate(() => ({
      Branding: !!window.Branding, State: !!window.State, UI: !!window.UI,
      Api: !!window.Api, Exporter: !!window.Exporter, Receipt: !!window.Receipt,
      Router: !!window.Router, Theme: !!window.Theme,
    }));
    for (const [name, present] of Object.entries(reach)) {
      check(`window.${name} is reachable (feature guards on it work)`, present);
    }
  }

  console.log('\n=== THE PHARMACY\'S OWN NAME IS THE LETTERHEAD ===');
  {
    const out = await page.evaluate(async () => {
      const sales = await Api.get('/sales?limit=6');
      const list = sales.results || sales;
      const full = await Api.get(`/sales/${list[0].id}`);
      return {
        thermal: Receipt.build(full, { thermal: true }),
        a4: Receipt.build(full, { thermal: false }),
        report: Exporter.buildTableReport({
          title: 'Stock on hand', subtitle: 'All branches',
          columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }],
        }),
        displayName: Branding.displayName(),
        attribution: Branding.printAttribution(),
      };
    });

    check('Branding.displayName() returns the client name', out.displayName === CLIENT, out.displayName);
    check('the THERMAL receipt is headed with the client name',
      out.thermal.includes(CLIENT), out.thermal.slice(0, 120));
    check('...and does NOT fall back to the product name as its header',
      !/r-business">PharmaRidge</.test(out.thermal));
    check('the A4 receipt is headed with the client name', out.a4.includes(CLIENT));
    check('...and does NOT fall back to the product name as its header',
      !/print-business">PharmaRidge</.test(out.a4));
    check('a printed REPORT is headed with the client name', out.report.includes(CLIENT));
    check('...and does NOT fall back to the product name as its header',
      !/print-business">PharmaRidge</.test(out.report));

    console.log('\n=== "POWERED BY PHARMARIDGE" IS SUBTLE, AND ALWAYS THERE ===');
    check('the thermal receipt carries the attribution',
      /r-poweredby[^>]*>Powered by PharmaRidge</.test(out.thermal));
    check('the A4 receipt carries the attribution',
      /print-poweredby[^>]*>Powered by PharmaRidge</.test(out.a4));
    check('a printed report carries the attribution',
      /print-poweredby[^>]*>Powered by PharmaRidge</.test(out.report));
    check('the attribution never replaces the pharmacy name as the header',
      out.thermal.indexOf(CLIENT) < out.thermal.indexOf('Powered by PharmaRidge'),
      'the attribution appears BEFORE the pharmacy name');

    // "Subtle" is a real requirement, so it is measured rather than trusted.
    const sizes = await page.evaluate(() => {
      const src = document.querySelector('link[rel="stylesheet"]');
      const css = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules]; } catch { return []; } });
      const find = (sel) => {
        const r = css.find((x) => x.selectorText && x.selectorText.includes(sel));
        return r ? r.style.fontSize : null;
      };
      return { business: find('.r-business'), powered: find('.r-poweredby'), src: !!src };
    });
    if (sizes.business && sizes.powered) {
      check('the attribution is visually smaller than the pharmacy name',
        parseFloat(sizes.powered) < parseFloat(sizes.business),
        `${sizes.powered} vs ${sizes.business}`);
    } else {
      check('the on-screen receipt preview styles the thermal markup',
        !!sizes.business, 'no .r-business rule found in the app stylesheet');
    }
  }

  console.log('\n=== THE ON-SCREEN PREVIEW LOOKS LIKE THE PAPER ===');
  {
    // BUG 110: Receipt.screenHtml() emits the THERMAL markup, but those
    // classes lived only in export.js's THERMAL_CSS — injected into the print
    // frame, absent from the app page. The cashier's preview was unstyled.
    const styled = await page.evaluate(async () => {
      const sales = await Api.get('/sales?limit=3');
      const list = sales.results || sales;
      const full = await Api.get(`/sales/${list[0].id}`);
      const host = document.createElement('div');
      host.className = 'receipt';
      host.innerHTML = Receipt.screenHtml(full);
      document.body.appendChild(host);
      const biz = host.querySelector('.r-business');
      const line = host.querySelector('.r-line');
      const res = {
        businessWeight: biz ? getComputedStyle(biz).fontWeight : null,
        centred: biz ? getComputedStyle(biz.closest('.r-center') || biz).textAlign : null,
        lineDisplay: line ? getComputedStyle(line).display : null,
      };
      host.remove();
      return res;
    });
    check('the previewed business name is bold', Number(styled.businessWeight) >= 600, String(styled.businessWeight));
    check('the header block is centred like the roll', styled.centred === 'center', String(styled.centred));
    check('label/amount pairs sit on one line, not stacked', styled.lineDisplay === 'flex', String(styled.lineDisplay));
  }

  await browser.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
