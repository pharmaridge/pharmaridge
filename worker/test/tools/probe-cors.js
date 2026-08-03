// CORS / BROWSER-SECURITY PROBE — executed against the running Worker.
//
// index.js mounts `app.use('*', cors())` with NO configuration. Hono's default
// is `Access-Control-Allow-Origin: *`. The comment above it argues this is
// safe because auth is a Bearer token rather than a cookie, so there is no
// CSRF exposure. That argument is CORRECT as far as it goes — but it has never
// been executed, and "no CSRF" is not the same as "no risk":
//
//   * With `*`, ANY website a pharmacist visits can call this API from their
//     browser. It cannot read the response WITHOUT a token... but if it ever
//     obtains one (XSS on any page, a leaked token in a screenshot, a shared
//     kiosk), every origin on the internet can use it directly from the
//     victim's browser.
//   * More concretely: `*` and `Allow-Credentials: true` together are refused
//     by browsers. If credentials are ever echoed, requests break in a way
//     that is very hard to diagnose in the field.
//
// This measures what the server ACTUALLY sends, then checks the specific
// combinations that are dangerous rather than asserting a policy preference.
const BASE = process.env.WORKER_BASE || 'http://127.0.0.1:9001';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const EVIL = 'https://evil.example.com';

  console.log('\n=== A. WHAT THE SERVER ACTUALLY SENDS ===');
  const pre = await fetch(`${BASE}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' },
  });
  const h = (n) => pre.headers.get(n);
  console.log(`     preflight status        : ${pre.status}`);
  console.log(`     Allow-Origin            : ${h('access-control-allow-origin')}`);
  console.log(`     Allow-Credentials       : ${h('access-control-allow-credentials')}`);
  console.log(`     Allow-Methods           : ${h('access-control-allow-methods')}`);
  console.log(`     Allow-Headers           : ${h('access-control-allow-headers')}`);

  const allowOrigin = h('access-control-allow-origin');
  const allowCreds = h('access-control-allow-credentials');

  // THE COMBINATION THAT IS ACTUALLY BROKEN/DANGEROUS.
  // `*` + credentials is rejected outright by every browser; a wildcard that
  // is silently REFLECTED back with credentials is the classic account-takeover
  // misconfiguration.
  check('wildcard origin is not combined with Allow-Credentials',
    !(allowOrigin === '*' && String(allowCreds) === 'true'),
    'browsers refuse this pair outright — requests would fail in the field with no clear cause');
  check('the origin is not blindly REFLECTED with credentials',
    !(allowOrigin === EVIL && String(allowCreds) === 'true'),
    'reflecting an arbitrary origin WITH credentials is the classic CORS account-takeover hole');

  console.log('\n=== B. AUTH STILL REQUIRED CROSS-ORIGIN (no cookie ambient authority) ===');
  // The whole "wildcard is safe here" argument rests on this: without a token,
  // a cross-origin request must get nothing. Prove it rather than assume it.
  const noTok = await fetch(`${BASE}/api/dashboard/summary`, { headers: { Origin: EVIL } });
  check('a cross-origin read with NO token is refused', noTok.status === 401,
    `status=${noTok.status}`);
  const badTok = await fetch(`${BASE}/api/dashboard/summary`, {
    headers: { Origin: EVIL, Authorization: 'Bearer not-a-real-token' },
  });
  check('a cross-origin read with a FORGED token is refused', badTok.status === 401,
    `status=${badTok.status}`);

  console.log('\n=== C. NO COOKIES ARE ISSUED (the CSRF argument must be true) ===');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: EVIL },
    body: JSON.stringify({ username: 'manager', pin: '1234' }),
  });
  const setCookie = login.headers.get('set-cookie');
  check('login issues NO Set-Cookie (so there is no ambient authority to abuse)',
    !setCookie, String(setCookie));
  const body = await login.json();
  check('login returns a bearer token in the body instead', !!body.token);

  console.log('\n=== D. SECURITY HEADERS ON API RESPONSES ===');
  // public/_headers covers the STATIC assets served by Pages. API responses
  // come from the Worker and never pass through that file, so they are only
  // as safe as what the Worker itself sets. An API that returns JSON with no
  // nosniff can be coerced into being interpreted as another content type.
  const api = await fetch(`${BASE}/api/health`);
  const ct = api.headers.get('content-type') || '';
  check('API responses declare JSON', /application\/json/.test(ct), ct);
  const nosniff = api.headers.get('x-content-type-options');
  check('API responses send X-Content-Type-Options: nosniff',
    String(nosniff).toLowerCase() === 'nosniff',
    `got ${nosniff} — without it a browser may sniff a JSON body as another type`);
  const frame = api.headers.get('x-frame-options');
  const csp = api.headers.get('content-security-policy');
  check('API responses cannot be framed (clickjacking on an API error page)',
    !!frame || (csp && /frame-ancestors/.test(csp)),
    `X-Frame-Options=${frame} CSP=${csp}`);

  console.log('\n=== E. THE ERROR HANDLER MUST NOT LEAK INTERNALS ===');
  // A 500 that echoes a SQL string or a stack trace hands an attacker the
  // schema. Force one and read what comes back.
  const tok = body.token;
  const bad = await fetch(`${BASE}/api/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: 'x'.repeat(3), generic_name: null, unit_of_measure: null }),
  });
  const badBody = await bad.text();
  console.log(`     forced-error status: ${bad.status}`);
  const leaks = [/SQLITE_/i, /D1_ERROR/i, /at \w+ \(/, /\/src\//, /node_modules/, /SELECT .* FROM/i, /INSERT INTO/i];
  const found = leaks.filter((re) => re.test(badBody));
  check('an error response leaks no SQL, stack trace or file path',
    found.length === 0, `${found.length} leak pattern(s) in: ${badBody.slice(0, 160)}`);

  console.log('\n' + '='.repeat(62));
  console.log(`CORS/SECURITY PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
