const { Hono } = require('hono');
const { cors } = require('hono/cors');
const { secureHeaders } = require('hono/secure-headers');
const { pruneIdempotencyKeys } = require('./lib/idempotency');
const { pruneSyncChangeLog, pruneLoginAttempts, pruneReviewedSyncConflicts } = require('./lib/retention');
const { getStorageHealth } = require('./lib/storageHealth');
const { authRequired } = require('./lib/auth');
const { subscriptionGate, getClientSettings } = require('./lib/planLimits');


const app = new Hono();

// CORS: the Pages-hosted frontend and this Worker are typically on
// different subdomains (e.g. app.yourpharmacy.com vs
// api.yourpharmacy.com), so the browser enforces CORS. Bearer-token auth
// (no cookies) means this can be permissive without a CSRF exposure — same
// reasoning documented in the original design.
app.use('*', cors());

// BUG 66 — API RESPONSES CARRIED NO SECURITY HEADERS AT ALL.
//
// public/_headers sets nosniff / X-Frame-Options / Referrer-Policy / CSP for
// the static assets, but that file is a CLOUDFLARE PAGES feature: it is
// applied by Pages to the files Pages serves. Every /api/* response comes from
// this Worker and never passes through it. Measured against the running
// Worker: X-Content-Type-Options, X-Frame-Options, Referrer-Policy and CSP
// were all absent from /api/health.
//
// Why it matters for THIS product, not in the abstract:
//   * No nosniff on a JSON body is the precondition for content-type
//     sniffing attacks; an endpoint that echoes user-controlled text (product
//     names, customer names, void reasons all do) can be coaxed into being
//     interpreted as HTML by an older browser.
//   * No frame protection means an API error or a JSON body can be framed by
//     a hostile page. The app itself is protected by _headers, but the API is
//     a separate origin in the recommended deployment (api.yourpharmacy.com),
//     so it needs its own.
//   * Referrer-Policy matters because URLs here contain record ids
//     (/api/sales/:id, /api/customers/:id); a default policy leaks them to
//     any third party in a Referer header.
//
// Tuned for a JSON API rather than accepting the defaults wholesale:
// crossOriginResourcePolicy and crossOriginEmbedderPolicy are deliberately
// LEFT OFF because the frontend is on a different origin from the Worker in
// the documented deployment and CORP would break the very cross-origin calls
// CORS is configured to allow. The CSP is the most restrictive one possible
// for a response that is only ever JSON: nothing may load, nothing may frame.
app.use('*', secureHeaders({
  xContentTypeOptions: 'nosniff',
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains',
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'none'"],
  },
  // Not applicable to a JSON API and actively harmful across origins.
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
}));

// GO-LIVE SAFETY GUARD (added during a production audit).
//
// JWT_SECRET is what stops anyone forging a login token. Two failure
// modes were reproduced by executing the real crypto helpers:
//
//   * secret undefined/empty  -> signToken() throws the raw WebCrypto
//     error "Zero-length key is not supported". Every login would 500
//     with an error that names nothing an operator could act on. This is
//     exactly what a forgotten `wrangler secret put JWT_SECRET` looks
//     like on first deploy.
//   * secret left as the published example value
//     ("local-dev-only-not-for-production", committed in
//     worker/.dev.vars.example and therefore PUBLIC) -> tokens sign and
//     verify perfectly. Verified: a forged token claiming role=ADMIN is
//     accepted. A deployment that copied .dev.vars.example into
//     production would look completely healthy while anyone who read the
//     repo could mint an admin session.
//
// The docs already warn about both; nothing enforced either. This turns a
// silent catastrophic misconfiguration into a loud, self-explaining
// refusal at the only place it can be caught on Workers (per-request —
// there is no server "startup" hook, and env is not available at module
// scope).
const INSECURE_SECRETS = new Set([
  'local-dev-only-not-for-production',
  'changeme', 'change-me', 'secret', 'password', 'test', 'dev',
]);
const MIN_SECRET_LENGTH = 16;

function jwtSecretProblem(env) {
  const secret = env && env.JWT_SECRET;
  if (!secret) return 'JWT_SECRET is not set';
  if (INSECURE_SECRETS.has(String(secret).trim().toLowerCase())) {
    return 'JWT_SECRET is still the example/placeholder value from .dev.vars.example, which is published in this repository';
  }
  if (String(secret).length < MIN_SECRET_LENGTH) {
    return `JWT_SECRET is only ${String(secret).length} characters; at least ${MIN_SECRET_LENGTH} are required`;
  }
  return null;
}

// Local development is deliberately exempt: `wrangler dev` reads
// .dev.vars, and forcing every developer to invent a secret would just
// train them to ignore the warning. ENVIRONMENT is set to 'development'
// in .dev.vars / wrangler.jsonc vars for local runs.
function isLocalDev(env) {
  return env && (env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test');
}

app.use('*', async (c, next) => {
  const problem = jwtSecretProblem(c.env);
  if (problem && !isLocalDev(c.env)) {
    return c.json({
      error: 'This deployment is not configured securely and has been stopped to protect your data. '
        + `${problem}. Anyone who knows the signing secret can forge a login for any account, including the Admin Portal. `
        + 'Run:  npx wrangler secret put JWT_SECRET  '
        + '(generate a value with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))") '
        + 'then redeploy. See DEPLOYMENT-CLOUDFLARE.md Part 2.',
      code: 'INSECURE_JWT_SECRET',
    }, 503);
  }
  return next();
});

// Health check deliberately reports configuration status so an operator
// can verify a deployment BEFORE handing it to a pharmacy. It never
// echoes the secret itself — only whether it passes the checks above.
app.get('/api/health', async (c) => c.json({
  ok: true,
  env: c.env.ENVIRONMENT || 'production',
  jwt_secret_configured: !jwtSecretProblem(c.env),
  // Storage headroom: D1 Free caps a database at 500MB, and at that
  // ceiling WRITES FAIL while reads keep working — a pharmacy would
  // silently stop being able to record sales. See lib/storageHealth.js.
  storage: await getStorageHealth(c.env.DB),
  time: new Date().toISOString(),
}));

app.route('/api/auth', require('./routes/auth'));

// Public, unauthenticated — mirrors the original implementation Mounted
// before the subscription gate below too: branding must always be visible
// even on a SUSPENDED/EXPIRED account.
app.route('/api/branding', require('./routes/branding'));

// Dynamic PWA manifest — mirrors the equivalent route in the original
// design (see that file for the full rationale). On this deployment target
// it is reachable at /api/manifest.json rather than a bare /manifest.json,
// since Cloudflare Pages (not this Worker) serves the static file tree
// including the default public/manifest.json — see
// DEPLOYMENT-CLOUDFLARE.md's routing section for how to also route exactly
// this one path to the Worker so a branded client still gets a
// correctly-branded install experience without any other change. PWA
// `short_name` is the home-screen label; Android/iOS truncate it at
// roughly 12 characters. Prefer whole words so the label reads as a real
// name rather than a chopped fragment. See the call site for the full bug
// write-up.
const MAX_SHORT_NAME = 12;
function toHomeScreenLabel(businessName) {
  const raw = String(businessName || '').trim().replace(/\s+/g, ' ');
  if (!raw) return null;
  if (raw.length <= MAX_SHORT_NAME) return raw;
  // Accumulate whole words while they still fit.
  let label = '';
  for (const word of raw.split(' ')) {
    const next = label ? `${label} ${word}` : word;
    if (next.length > MAX_SHORT_NAME) break;
    label = next;
  }
  // A single word longer than the budget (e.g. "Pharmaceuticals") has no
  // word boundary to break on — hard-slice it rather than return empty.
  return label || raw.slice(0, MAX_SHORT_NAME);
}

app.get('/api/manifest.json', async (c) => {
  const settings = await getClientSettings(c.env.DB);

  const name = settings.business_name ? `${settings.business_name} — Powered by PharmaRidge` : 'PharmaRidge';

  // BUG FOUND AND FIXED DURING A PRODUCTION AUDIT (reproduced live
  // against real workerd + D1, not inferred): `short_name` was the raw
  // business_name, uncapped. admin.js permits a business_name of up to
  // 80 characters, so a real client name like "Zubby Memorial
  // Pharmaceuticals and Health Stores Nigeria Ltd" produced a 60-char
  // short_name — measured on the live endpoint.
  //
  // `short_name` is specifically the HOME-SCREEN LABEL. Android/iOS
  // budget roughly 12 characters before hard-truncating with an
  // ellipsis, so the installed icon read "Zubby Memori…" — the exact
  // opposite of the branded, professional install this feature exists
  // to deliver. The static public/manifest.json has always been held to
  // a <=12 rule by audit.pwa.js, but that check only ever read the
  // STATIC file; the DYNAMIC manifest (the one index.html actually
  // links, and the only one a branded client ever receives) was never
  // checked at all, so the rule was silently unenforced exactly where
  // it mattered.
  //
  // Truncate on a WORD boundary where possible ("Zubby Memorial" ->
  // "Zubby", never "Zubby Memori"), falling back to a hard slice for a
  // single long word. Full name is unaffected and still carries the
  // complete business name.
  const shortName = toHomeScreenLabel(settings.business_name) || 'PharmaRidge';
  const logoMimeMatch = settings.logo_data_url ? /^data:(image\/[a-zA-Z0-9.+-]+);/.exec(settings.logo_data_url) : null;
  const logoMime = logoMimeMatch?.[1] || 'image/png';
  const icons = settings.logo_data_url
    ? [
        { src: '/api/branding/logo', sizes: '192x192', type: logoMime, purpose: 'any' },
        { src: '/api/branding/logo', sizes: '512x512', type: logoMime, purpose: 'any' },
        // See the original design for the full rationale on always using the
        // generic PharmaRidge maskable icons here (mirrored) even for a branded
        // client — a client's uploaded logo isn't guaranteed to have the safe-zone
        // padding a maskable icon needs, so using it unmodified risks a badly
        // cropped install icon under Android's adaptive-icon masking.
        { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ]
    : [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
  return c.json({
    id: '/',
    name, short_name: shortName,
    description: 'Multi-branch pharmacy / patent medicine store management system — offline-first POS, inventory, accounting and compliance, by PharmaRidge.',
    start_url: '/', scope: '/', lang: 'en', dir: 'ltr',
    display: 'standalone', display_override: ['standalone', 'minimal-ui', 'browser'],
    // background_color is the first PWA splash surface shown before login
    // JavaScript or application branding has loaded. The premium logo is
    // transparent and emerald-forward, so this deliberately matches the app's
    // deepest green instead of the former slate badge colour. Keep in sync
    // with public/manifest.json (the static fallback manifest).
    background_color: '#0a3b2c', theme_color: '#0a3b2c', orientation: 'portrait-primary',
    categories: ['business', 'medical', 'productivity', 'finance'],
    prefer_related_applications: false,
    icons,
    // Mirrors the original implementation's identical shortcuts list.
    shortcuts: [
      { name: 'Point of Sale', short_name: 'POS', description: 'Jump straight to the checkout screen', url: '/#/pos', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Till / Cash', short_name: 'Till', description: 'Open or close a till session', url: '/#/till', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
      { name: 'Stock & Expiry', short_name: 'Stock', description: 'Check stock levels and expiry alerts', url: '/#/stock', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  });
});

// Blocks all business-mutating requests (everything but GET) once this
// client's subscription is SUSPENDED/EXPIRED — mirrors the original
// design's equivalent gate in the original implementation Mounted after
// /api/auth (login must always work) and before every other business
// route; GET requests pass through untouched.
//
// IMPORTANT: these are two SEPARATE app.use registrations, each calling
// Hono's real `next` directly — not one middleware that wraps `next`
// inside a nested closure (e.g. `authRequired(c, => subscriptionGate(c,
// next))`). That nested-closure form was tried first and failed in
// production-realistic testing: when subscriptionGate short-circuits with
// a blocking c.json response several call-frames deep inside
// authRequired's own `await next`, Hono's compose dispatcher loses track
// of the response and throws "Context is not finalized. Did you forget to
// return a Response object or `await next`?" — reproduced with a real
// `wrangler dev` + local D1 request (`POST /api/expenses` while SUSPENDED
// returned a raw 500 instead of the intended 403). Keeping each middleware
// flat (each one only ever calls the exact `next` Hono itself handed it)
// avoids the bug entirely and was verified to fix it.
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  return authRequired(c, next);
});
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'GET') return next();
  // A subscription state must never trap the actual proprietor with data they
  // need to retain, export or securely remove. This is deliberately the one
  // Owner-only destructive endpoint that remains reachable while suspended:
  // it cannot create new trading activity, and its own route repeats Owner
  // identity, active-operation, acknowledgement and typed-confirmation gates.
  // ADMIN already bypasses the gate below, but data-management itself refuses
  // ADMIN so support cannot use this exception to erase client records.
  if (c.req.path === '/api/data-management/purge' && c.get('user') && c.get('user').role === 'OWNER') return next();
  return subscriptionGate(c, next);
});

// DATA-RESET REPLAY FENCE.
//
// A full data reset is not safe if an old PWA queue can reconnect tomorrow and
// silently recreate a sale, expense or customer after the Owner has started
// clean. The browser now forwards the item’s ORIGINAL queue timestamp with an
// offline replay. When the reset marker is present, any replay made before it
// (or an older app replaying without a timestamp) is quarantined with a clear
// 409 rather than being treated as a new live transaction. Live counter work
// carries no X-Offline-Replay header and is unaffected.
app.use('/api/*', async (c, next) => {
  if (c.req.header('X-Offline-Replay') !== '1') return next();
  const settings = await getClientSettings(c.env.DB);
  if (!settings.data_reset_at) return next();
  const rawQueuedAt = c.req.header('X-Offline-Queued-At');
  const queuedAt = rawQueuedAt ? Date.parse(rawQueuedAt) : NaN;
  const resetAt = Date.parse(`${String(settings.data_reset_at).replace(' ', 'T')}Z`);
  if (!Number.isFinite(queuedAt) || !Number.isFinite(resetAt) || queuedAt <= resetAt) {
    return c.json({
      error: 'This offline item was created before the Owner cleared business data. It was not replayed. Review or discard it on the device before recording the transaction again.',
      code: 'DATA_RESET_REPLAY_BLOCKED',
    }, 409);
  }
  return next();
});

app.route('/api/branches', require('./routes/branches'));
app.route('/api/users', require('./routes/users'));
app.route('/api/products', require('./routes/products'));
// NAFDAC approved-product catalog (read-only reference data, migration 0002).
// Mounted alongside /api/products rather than under it so the catalog's own
// authorisation (authRequired, not managerOnly) is explicit: STAFF must be
// able to search it from the POS, while creating a product from a catalog row
// stays manager-gated on POST /api/products.
app.route('/api/catalog', require('./routes/catalog'));
app.route('/api/suppliers', require('./routes/suppliers'));
app.route('/api/purchase-orders', require('./routes/purchaseOrders'));
app.route('/api/stock', require('./routes/stock'));
app.route('/api/customers', require('./routes/customers'));
app.route('/api/sales', require('./routes/sales'));
app.route('/api/till', require('./routes/till'));
app.route('/api/stocktakes', require('./routes/stocktakes'));
app.route('/api/adjustments', require('./routes/adjustments'));
app.route('/api/transfers', require('./routes/transfers'));
app.route('/api/expenses', require('./routes/expenses'));
app.route('/api/creditors', require('./routes/creditors'));
app.route('/api/change-owed', require('./routes/changeOwed'));
app.route('/api/safe', require('./routes/safe'));
app.route('/api/gl', require('./routes/gl'));
app.route('/api/controlled-register', require('./routes/controlledRegister'));
app.route('/api/dashboard', require('./routes/dashboard'));
app.route('/api/sync', require('./routes/sync'));
app.route('/api/attendance', require('./routes/attendance'));
app.route('/api/admin', require('./routes/admin'));
app.route('/api/settings', require('./routes/settings'));
app.route('/api/data-management', require('./routes/dataManagement'));
app.route('/api/wht', require('./routes/wht'));


app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Central error handler — maps raw D1/SQLite constraint errors to clean
// 4xx responses, mirroring the original design's equivalent handler, so a
// route that forgot to pre-validate a reference still degrades gracefully
// instead of leaking a raw 500 with an internal error string.
app.onError((err, c) => {
  console.error('[error]', err);

  const message = String(err.message || '');
  if (message.includes('FOREIGN KEY constraint')) {
    return c.json({ error: 'One of the referenced records (e.g. branch, product, supplier, or user) does not exist.' }, 400);
  }
  if (message.includes('UNIQUE constraint')) {
    return c.json({ error: 'A record with that unique value already exists.' }, 400);
  }
  if (message.includes('NOT NULL constraint')) {
    return c.json({ error: 'A required field is missing.' }, 400);
  }
  if (message.includes('CHECK constraint')) {
    return c.json({ error: 'One of the submitted values is not allowed for this field.' }, 400);
  }

  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  return c.json({ error: status === 500 ? 'Internal server error' : err.message }, status);
});

// Cron Trigger handler (configure in wrangler.jsonc under
// `triggers.crons`) — periodic housekeeping of the idempotency_keys table,
// mirroring the original design's lib/retention.js. Cron Trigger handler
// (configure in wrangler.jsonc under `triggers.crons`) — periodic
// housekeeping of the idempotency_keys table AND sync_change_log,
// mirroring the original design's lib/retention.js. PARITY GAP FOUND AND
// FIXED during this audit pass — see lib/retention.js's pruneSyncChangeLog
// comment for the full write-up: this previously only pruned
// idempotency_keys, leaving sync_change_log to grow completely unboundedly
// on this deployment, which a production deployment cannot tolerate.
async function scheduled(event, env, ctx) {
  ctx.waitUntil(pruneIdempotencyKeys(env.DB));
  ctx.waitUntil(pruneSyncChangeLog(env.DB));
  // Authentication audit trail (login_attempts, created in 0001) — same 90-day retention.
  ctx.waitUntil(pruneLoginAttempts(env.DB));
  // BUG 47: sync_conflicts grew forever — reviewing a conflict only hides
  // it, it never deleted the row. UNREVIEWED conflicts are kept at any age
  // (they are an unanswered question about a customer record); reviewed
  // ones go after 180 days. See lib/retention.js for the full rationale.
  ctx.waitUntil(pruneReviewedSyncConflicts(env.DB));
}

// Real ESM `export default` (NOT `module.exports.default = ...`, which
// Wrangler/esbuild does not recognize as a module default export and
// will refuse to build with "Worker has no default export"). Internal
// files stay CommonJS (require/module.exports) for consistency with the
// rest of the project and Node-based tooling; esbuild's bundler freely
// mixes both module systems within a single bundle, so only the actual
// entrypoint needs real `export` syntax.
export default { fetch: app.fetch, scheduled };
