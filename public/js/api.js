// Thin fetch wrapper: attaches auth, resolves branch scope, and — for
// a whitelisted set of "safe to queue offline" mutations (currently:
// creating a sale or recording an expense) — falls back to the offline
// queue when the network request itself fails, so a branch can keep
// selling / recording expenses with no connectivity at all.
//
// Idempotency: every queueable request is assigned a stable key BEFORE
// it is ever sent, and the exact same key is reused on every retry
// (including the offline-queue replay). That way, if a request actually
// reached the server and succeeded but the *response* never made it back
// (e.g. the connection drops right as the sale is completing), retrying
// cannot create a duplicate sale — the server recognizes the repeated
// key and replays the original result instead of re-running the sale.
//
// Session expiry: the server can return 401 for reasons that have
// nothing to do with a bad password — a 12h JWT expiring mid-shift, or a
// manager deactivating a user while they're logged in elsewhere. Without
// handling this centrally, a cashier would just see a wall of scattered
// "Missing auth token" / "Account has been deactivated" toasts across
// whichever screen they happened to be on, with no obvious way back in.
// Every request funnels through here, so a single handler forces a clean
// logout + redirect to the login screen with one clear message, while
// deliberately NOT doing this for the login endpoint itself (a wrong PIN
// is an expected, normal 401 there, not a session expiry).
const Api = (() => {
  const BASE = '/api';

  const OFFLINE_QUEUEABLE = [
    { method: 'POST', pathTest: (p) => p === '/sales' },
    { method: 'POST', pathTest: (p) => p === '/expenses' },
  ];

  function isQueueable(method, path) {
    return OFFLINE_QUEUEABLE.some((r) => r.method === method && r.pathTest(path));
  }

  function newIdempotencyKey() {
    return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  let sessionExpiredHandled = false;
  function resetSessionExpiredGuard() {
    sessionExpiredHandled = false;
  }
  function handleSessionExpired(message) {
    if (sessionExpiredHandled) return; // avoid a stampede of redirects if several in-flight requests all 401 at once
    sessionExpiredHandled = true;
    State.clearSession();
    UI.toast(message || 'Your session has ended. Please sign in again.', 'warn', 8000);
    location.hash = '#/dashboard';
    // LEGACY-BROWSER COMPATIBILITY: written without optional chaining
    // (`window.App?.afterLogout`) — see the file-header note in
    // public/js/ui.js for the full rationale. Optional chaining/
    // nullish-coalescing are ES2020 syntax; a browser/WebView that predates
    // them throws a hard SyntaxError while *parsing* the script, before a
    // single line runs, which fails the ENTIRE app (blank white screen) rather
    // than degrading one feature — a real risk for the budget/older Android
    // devices common in this product's actual target market. This codebase
    // deliberately avoids that syntax everywhere in public/js/ (the code every
    // browser must parse), while still freely using modern syntax in server/
    // and worker/src/ (which only ever runs in Node 22 / Cloudflare Workers'
    // V8 isolates, never in an end-user browser).
    if (window.App && window.App.afterLogout) window.App.afterLogout();
  }

  async function request(method, path, body, { allowOfflineQueue = true, idempotencyKey, offlineReplay = false, queuedAt } = {}) {
    const session = State.getSession();
    const headers = { 'Content-Type': 'application/json' };
    if (session && session.token) headers.Authorization = `Bearer ${session.token}`;

    // Tell the server this request is a QUEUED SALE BEING REPLAYED, not a
    // live action at the counter. The two are indistinguishable by payload
    // but must be judged differently: a live cash sale with no open till is
    // refused (the cashier can just open one), whereas a replay describes
    // money that was ALREADY taken hours ago. Refusing a replay does not
    // undo the sale — it only erases the record, because offline.js treats
    // every 4xx as permanent and quarantines the item. Reproduced exactly
    // that way while adding the no-open-till guard in routes/sales.js.
    if (offlineReplay) {
      headers['X-Offline-Replay'] = '1';
      // A full Owner reset records its server time. Supplying the original
      // queue time lets the server quarantine a stale request instead of
      // silently repopulating a freshly-cleared database when an old phone
      // reconnects. The server refuses a replay lacking this header after a
      // reset — a deliberate safe failure for older cached PWA shells.
      if (queuedAt) headers['X-Offline-Queued-At'] = queuedAt;
    }

    // Assign a stable idempotency key up front for any mutation we might
    // need to queue/retry, so a lost-response retry can never double-run.
    const queueable = isQueueable(method, path);
    const effectiveKey = idempotencyKey || (queueable ? newIdempotencyKey() : null);
    if (effectiveKey) headers['Idempotency-Key'] = effectiveKey;

    const url = BASE + path;
    const isLoginCall = path === '/auth/login';
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      // SLIDING SESSION — see authRequired() in worker/src/lib/auth.js.
      // Once a token passes the halfway point of its 12-hour life the
      // server returns a fresh one here; swapping it in silently means an
      // actively-used till never gets logged out mid-trade. Applied
      // BEFORE the ok/!ok branch so a renewal riding along on an error
      // response (e.g. a 409 during a busy shift) is still honoured.
      try {
        const renewed = resp.headers.get('X-Renewed-Token');
        if (renewed) {
          const current = State.getSession();
          // Only if still signed in as the same person: a renewal that
          // raced a logout must never resurrect a dead session.
          if (current && current.token && renewed !== current.token) {
            State.setSession(Object.assign({}, current, { token: renewed }));
          }
        }
      } catch (e) { /* never let token renewal break a real response */ }

      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        const err = new Error((data && data.error) || `Request failed (${resp.status})`);
        err.status = resp.status;
        err.code = data && data.code;
        if (resp.status === 401 && !isLoginCall && session && session.token) {
          handleSessionExpired(data && data.error);
        }
        throw err;
      }
      return data;
    } catch (e) {
      const isNetworkError = e instanceof TypeError; // fetch throws TypeError on network failure
      if (isNetworkError && allowOfflineQueue && queueable) {
        // BUG 67 — THE ONE MESSAGE A CASHIER MUST BE ABLE TO ACT ON.
        //
        // Writing to IndexedDB can genuinely fail: a budget Android phone with
        // a nearly-full disk refuses with QuotaExceededError, and a locked-down
        // WebView or private window can refuse to open the database at all.
        //
        // The BEHAVIOUR here was already correct and was verified before
        // changing anything: Offline.enqueue() rejects, nothing is persisted,
        // the rejection propagates WITHOUT `queued`, and views/pos.js therefore
        // takes its else-branch — the cart is preserved and the sale is not
        // treated as captured. No money is lost. That is the important half and
        // it is now regression-locked.
        //
        // What was wrong is what the person at the counter is TOLD. The raw
        // rejection surfaced verbatim, so the toast read:
        //     "QuotaExceededError: The quota has been exceeded."
        // to a cashier holding a customer's money, with no indication of
        // whether the sale was saved, what to do, or that their phone is full.
        // Re-thrown here as plain language that states the two things they
        // need: the sale was NOT saved, and the goods must not be handed over.
        try {
          await Offline.enqueue({ method, path, body, idempotencyKey: effectiveKey });
        } catch (storageErr) {
          const failed = new Error(
            'This could NOT be saved — your device storage is full or unavailable, and you are offline. '
            + 'Do NOT hand over the goods. Free up space on the device (or reconnect to the internet) and try again. '
            + 'Nothing has been recorded.'
          );
          // Deliberately NOT `queued`: views/pos.js branches on that flag to
          // decide whether to clear the cart. Marking this queued would throw
          // the basket away along with the sale.
          failed.storageFull = true;
          failed.cause = storageErr;
          try { UI.updateOfflineBanner(); } catch (_) { /* banner is cosmetic here */ }
          throw failed;
        }
        UI.updateOfflineBanner();
        const err = new Error('You are offline. This has been queued and will sync automatically once connection returns.');
        err.queued = true;
        throw err;
      }
      throw e;
    }
  }

  const get = (path) => request('GET', path);
  const post = (path, body, opts) => request('POST', path, body, opts);
  const put = (path, body) => request('PUT', path, body);
  const del = (path) => request('DELETE', path);

  // Appends the manager's chosen "view branch" (if any) as a query param
  // so drill-down works without staff being able to override their own
  // forced branch scope (the API enforces that server-side regardless).
  function withScope(path) {
    const branchId = State.getViewBranch();
    if (!branchId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}branch_id=${branchId}`;
  }

  // Guards against two overlapping flush attempts (e.g. the 'online'
  // event and the periodic 30s sync timer firing close together) both
  // reading the same pending queue and sending duplicate requests. Not a
  // correctness requirement — Idempotency-Key already makes a duplicate
  // send harmless — but avoids doubling up network traffic for nothing.
  let flushInProgress = false;
  async function flushQueue() {
    if (flushInProgress) return { ok: 0, failed: 0, permanentlyFailed: 0, remaining: await Offline.count(), skipped: true };
    flushInProgress = true;
    try {
      const result = await Offline.flush(async (item) => {
        await request(item.method, item.path, item.body, {
          allowOfflineQueue: false, idempotencyKey: item.idempotencyKey,
          offlineReplay: true, queuedAt: item.queuedAt,
        });
      });
      UI.updateOfflineBanner();
      return result;
    } finally {
      flushInProgress = false;
    }
  }

  // CHUNKED "BIT-BY-BIT" PUSH of any customer records edited while
  // offline (see offline.js's queueCustomerEdit/processCustomerSyncQueue
  // for the full rationale) — sends the queue to the generic
  // POST /api/sync/push endpoint in small batches (15 per request by
  // default) rather than as one large payload, exactly matching
  // Cloudflare's own documented guidance for staying within the
  // Workers/D1 free-tier ceilings on the Cloudflare deployment target,
  // and capped server-side regardless (see MAX_PUSH_ROWS_PER_TABLE in
  // syncService.js) so an oversized push is never silently accepted
  // even if this client-side chunking were ever bypassed or changed.
  // A fresh Idempotency-Key per chunk means a lost response mid-sync
  // (the network drops the instant a chunk finishes committing) can be
  // safely retried without double-applying that chunk's upserts.
  let customerPushInProgress = false;
  async function pushCustomerQueue(branchId) {
    if (customerPushInProgress) return { ok: 0, failed: 0, remaining: await Offline.customerEditCount(), skipped: true };
    customerPushInProgress = true;
    try {
      const result = await Offline.processCustomerSyncQueue(async (chunk, remainingAfter) => {
        // The earliest queued customer in this push is the safe time to send:
        // if any part of the chunk predates an Owner reset, the server rejects
        // the whole stale chunk for review rather than allowing one old record
        // to repopulate the clean database. `_queued_at` is local metadata and
        // the server's sync allow-list drops it from the customer row itself.
        const queuedTimes = chunk.map((row) => Date.parse(row._queued_at || '')).filter((v) => Number.isFinite(v));
        const earliestQueuedAt = queuedTimes.length ? new Date(Math.min.apply(null, queuedTimes)).toISOString() : null;
        await request('POST', '/sync/push', {
          branch_id: branchId,
          device_id: DeviceId.get(),
          app_version: '1.0.0',
          changes: { customers: chunk },
          remaining_after_this_chunk: remainingAfter,
        }, {
          allowOfflineQueue: false, idempotencyKey: newIdempotencyKey(),
          offlineReplay: true, queuedAt: earliestQueuedAt,
        });
      });
      UI.updateOfflineBanner();
      return result;
    } finally {
      customerPushInProgress = false;
    }
  }

  return { get, post, put, del, withScope, flushQueue, pushCustomerQueue, resetSessionExpiredGuard };
})();

// BUG 111 — `window.Api` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.Api && Api.thing())` — a reasonable-looking defensive idiom that
// is in fact ALWAYS FALSE here, so the guarded branch never runs and the
// fallback is taken silently and forever.
//
// What that actually cost: every receipt and every printed report showed
// "PharmaRidge" as the letterhead instead of the client's own pharmacy name,
// on every white-labelled deployment, since day one. Nothing errored — the
// fallback was a legitimate-looking default.
//
// Publishing the module on `window` makes those guards true and keeps them
// honest as guards (a module genuinely not loaded is still falsy). Assigning
// here rather than rewriting ~11 call sites is deliberate: the next such
// guard someone writes will also work.
window.Api = Api;
