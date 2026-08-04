// Offline-first queue: when a mutating API call fails due to network
// unavailability, it's stashed in IndexedDB and retried automatically once
// the browser comes back online (or on a timer). This is what lets a
// branch keep selling / receiving stock / recording expenses with no
// connectivity at all, and catch up with the server later — mirroring the
// sync design in the schema (branch_sync_status / sync_change_log).
//
// TWO DIFFERENT QUEUES, mirroring the two sync mechanisms documented in
// the original implementation's architectural note — do not conflate them:
// 1. `pending_requests` (below) — exact API-call replay for sales/
// expenses (anything with real business logic: stock deduction,
// controlled-drug register, till cash-math). Each queued item is the
// literal method/path/body of the original request, replayed one at a time
// through the SAME endpoint that would have handled it online, protected
// by Idempotency-Key. 2. `pending_customer_edits` (new) — plain
// reference-data edits (currently: customers) queued for the generic,
// chunked /api/sync/push mechanism instead, since a customer record has no
// derived side effects to replay — it's a straightforward last-write-wins
// upsert. Keyed by the record's own id so multiple offline edits to the
// SAME customer collapse to just the latest version before ever reaching
// the network, exactly matching the last-write-wins semantics the server
// already applies.
const Offline = (() => {
  const DB_NAME = 'gl_pms_offline';
  const STORE = 'pending_requests';
  const CUSTOMER_STORE = 'pending_customer_edits';
  // FAILED_STORE holds queued requests that the server ACTIVELY
  // REJECTED (a 4xx response) rather than ones that simply couldn't
  // reach the network — see flush()'s full rationale below for why
  // these must never be retried blindly forever.
  const FAILED_STORE = 'failed_requests';
  const DB_VERSION = 3; // bumped from 2 to add FAILED_STORE — existing pending_requests/pending_customer_edits data survives the upgrade untouched
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(CUSTOMER_STORE)) {
          // Keyed by the customer's own id (not autoIncrement) so a
          // second offline edit to the same customer overwrites the
          // first pending edit in place, rather than queueing two
          // separate stale-vs-fresh versions of the same record.
          db.createObjectStore(CUSTOMER_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(FAILED_STORE)) {
          db.createObjectStore(FAILED_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function enqueue(request) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const rec = Object.assign({}, request, { queuedAt: new Date().toISOString() });
      const addReq = store.add(rec);
      addReq.onsuccess = () => resolve(addReq.result);
      addReq.onerror = () => reject(addReq.error);
    });
  }

  async function getAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function remove(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function count() {
    const all = await getAll();
    return all.length;
  }

  // ---- Permanently-rejected queue (server actively said "no", not just unreachable) ----

  async function moveToFailed(item, errorMessage, status) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, FAILED_STORE], 'readwrite');
      tx.objectStore(STORE).delete(item.id);
      // LEGACY-BROWSER COMPATIBILITY: object rest destructuring
      // (`const { id, ...rest } = item`) and object spread
      // (`{ ...rest, ... }`) are both ES2018 syntax — rewritten with
      // plain `Object.assign()` + `delete`, which have been available
      // since ES5/IE9. See public/js/api.js's handleSessionExpired
      // comment for the full "why avoid post-ES2015 syntax in browser
      // code" rationale.
      const rest = Object.assign({}, item);
      delete rest.id; // drop the old autoIncrement id so it gets a fresh one in FAILED_STORE
      tx.objectStore(FAILED_STORE).add(Object.assign({}, rest, { failedAt: new Date().toISOString(), errorMessage: errorMessage, status: status }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllFailed() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FAILED_STORE, 'readonly');
      const req = tx.objectStore(FAILED_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function removeFailed(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FAILED_STORE, 'readwrite');
      const req = tx.objectStore(FAILED_STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // Re-queues a failed item for another attempt (e.g. staff fixed the
  // underlying problem — restocked the product, reopened the till —
  // and wants to retry it exactly as originally captured) by moving it
  // back into the normal pending queue.
  async function retryFailed(id) {
    const db = await openDb();
    const failed = await getAllFailed();
    const item = failed.find((f) => f.id === id);
    if (!item) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, FAILED_STORE], 'readwrite');
      tx.objectStore(FAILED_STORE).delete(id);
      // LEGACY-BROWSER COMPATIBILITY — see moveToFailed()'s comment
      // above for the full rationale (mirrored here).
      const rest = Object.assign({}, item);
      delete rest.id;
      delete rest.failedAt;
      delete rest.errorMessage;
      delete rest.status;
      tx.objectStore(STORE).add(Object.assign({}, rest, { queuedAt: new Date().toISOString() }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function failedCount() {
    return (await getAllFailed()).length;
  }

  // Replays every queued request in order.
  //
  // CRITICAL DISTINCTION (found and fixed during a production audit):
  // a queued request can fail for two fundamentally different reasons,
  // and treating them identically was a real bug that could silently
  // wedge a device's ENTIRE offline queue forever:
  //   1. GENUINELY STILL OFFLINE / a transient network error — the
  //      request never reached the server at all (a plain TypeError
  //      from fetch, with no `.status`). Correct behavior: stop
  //      immediately and leave the rest queued for the next attempt —
  //      the device is probably still offline, so trying the next item
  //      would just fail identically and waste time/battery.
  //   2. THE SERVER ACTIVELY REJECTED THIS SPECIFIC REQUEST (a real
  //      HTTP error response, so `e.status` is a number) — e.g. a
  //      controlled-drug sale queued while offline that, by the time
  //      connectivity returned, referenced stock that had since sold
  //      out on another device (INSUFFICIENT_STOCK), or a till session
  //      that was force-closed by a manager in the meantime, or a cart
  //      that (somehow) exceeds MAX_SALE_ITEMS. This request will NEVER
  //      succeed no matter how many times it's retried — before this
  //      fix, `flush()` treated this exactly like case 1 and simply
  //      STOPPED, meaning every later item in the queue (a perfectly
  //      valid sale made five minutes after the bad one) would also
  //      never sync, with the UI just showing a permanently-growing,
  //      unexplained "N pending" count and "Sync Now" always claiming
  //      "still offline" even on a device with a perfect connection.
  //      Fixed: a genuine server rejection now moves ONLY that one item
  //      into a separate, staff-visible "failed" queue (surfaced on the
  //      Sync Status screen with the actual error message and a manual
  //      Retry/Discard action) and flush() CONTINUES on to the next
  //      queued item instead of giving up on the whole backlog.
  // BUG 68 — A DEVICE OFFLINE LONGER THAN THE SERVER'S IDEMPOTENCY WINDOW
  // COULD REPLAY A SALE AND RECORD IT TWICE.
  //
  // Exactly-once replay depends on the server still holding the
  // Idempotency-Key row for that request. The Worker prunes
  // idempotency_keys after 14 days (lib/idempotency.js, called from the
  // 6-hourly Cron Trigger). The queue here, by contrast, never expired
  // anything — so a device that was offline for longer replayed against a key
  // the server had already forgotten, and the request was processed as brand
  // new.
  //
  // LIVE-REPRODUCED, not theorised. Aged a real key to 20 days, ran the real
  // cron, replayed the identical request:
  //     replay after pruning -> status 201, sales created: 1
  // A second sale row, stock deducted a second time, revenue booked twice.
  // That is a device left in a drawer over a long holiday, or a spare tablet
  // used during an outage and reconnected weeks later — not an exotic case.
  //
  // Fixed on the CLIENT because only the client knows how long the item has
  // been waiting. Anything older than the safe window is moved to the
  // staff-visible failed queue instead of being replayed blind: a human then
  // sees the sale, its date and its amount, and decides whether it was already
  // recorded. Losing a sale to review is recoverable; silently duplicating one
  // corrupts the books and the stock count at the same time.
  //
  // The window is deliberately SHORTER than the server's 14 days. A replay
  // must be refused while the key is still guaranteed present, never in the
  // grey zone around the pruning boundary — the cron runs every 6 hours, so
  // the exact moment of pruning is not knowable from here.
  const IDEMPOTENCY_SAFE_DAYS = 10;

  function isBeyondSafeReplayWindow(item) {
    if (!item || !item.queuedAt) return false; // no timestamp: never quarantine on a guess
    const queued = Date.parse(item.queuedAt);
    if (!queued || Number.isNaN(queued)) return false;
    const ageDays = (Date.now() - queued) / 86400000;
    return ageDays > IDEMPOTENCY_SAFE_DAYS;
  }

  async function flush(sendFn) {
    const pending = await getAll();
    let ok = 0, failed = 0, permanentlyFailed = 0;
    for (const item of pending) {
      // BUG 68: refuse to replay past the point where the server can still
      // recognise this as a duplicate. See the note above.
      if (isBeyondSafeReplayWindow(item)) {
        await moveToFailed(
          item,
          'This has been waiting to sync for more than ' + IDEMPOTENCY_SAFE_DAYS + ' days. '
          + 'It was NOT sent automatically, because after this long the server can no longer tell '
          + 'whether it was already recorded, and sending it could record the same transaction twice. '
          + 'Check whether it already exists, then use Retry to send it or Discard to drop it.',
          0
        );
        permanentlyFailed++;
        continue;
      }
      try {
        await sendFn(item);
        await remove(item.id);
        ok++;
      } catch (e) {
        // THIRD CASE, added after a live-reproduced data-loss bug: an
        // AUTHENTICATION failure (401) or a rate-limit refusal (429) is neither
        // "this request is invalid" nor "we are offline" — it is "not right now,
        // but this exact request is still perfectly good".
        //
        // Reproduced by driving this real function with a 401: three genuine
        // offline sales were all moved into the permanently-failed queue purely
        // because the 12-hour JWT had expired overnight. They then required a
        // human to notice the banner, open Sync Status, and click Retry on each
        // one — for sales that were never wrong in the first place. A cashier who
        // sells offline through a night shift and signs in the next morning is
        // EXACTLY this scenario, not an edge case.
        //
        // 401 also cannot be retried item-by-item: api.js's handleSessionExpired
        // clears the session on the first one, so every later item in the same
        // flush would fail for a second, unrelated reason. Stop the whole flush
        // and keep everything queued — the very next flush after signing back in
        // replays them untouched, protected by their original Idempotency-Key. 401
        // (expired token), 429 (rate limited) and 5xx (a transient the original
        // implementation fault) all mean "NOT RIGHT NOW" — the request itself is
        // still perfectly valid. Only a 4xx is the server saying "this request is
        // wrong and always will be".
        //
        // The 5xx case was added after reproducing it: Cloudflare documents a
        // family of D1 faults ("Network connection lost", "storage caused object
        // to be reset", "D1 DB is overloaded") as routine operational noise whose
        // recommended handling is to RETRY. Those surface through app.onError as a
        // bare 500, and this branch previously quarantined the sale. Three genuine
        // offline sales were moved to the permanently-failed queue by a fault
        // Cloudflare calls expected — recoverable only if a human noticed the
        // banner and clicked Retry on each one.
        //
        // The Worker now absorbs most of these itself (worker/src/lib/d1Retry.js),
        // so this is the second layer: if one still escapes, the sale stays queued
        // and replays on the next cycle under its ORIGINAL Idempotency-Key, which
        // a 5xx deliberately releases server-side so the retry re-runs rather than
        // replaying a failure.
        if (e.status === 401 || e.status === 429 || e.status >= 500) {
          failed++;
          break;
        }
        if (typeof e.status === 'number') {
          // The server was reachable and gave a definitive answer — no
          // amount of retrying this exact request will change that.
          await moveToFailed(item, e.message, e.status);
          permanentlyFailed++;
          continue; // do NOT stop the whole queue over one bad item
        }
        failed++;
        break; // a genuine network failure — likely still offline, stop and retry everything next time
      }
    }
    return { ok, failed, permanentlyFailed, remaining: (await count()) };
  }

  // ---- Generic reference-data queue (customers, via /api/sync/push) ----

  async function queueCustomerEdit(customer) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOMER_STORE, 'readwrite');
      // `put` (not `add`): overwrites any earlier pending edit to this
      // same customer id, so the queue always holds at most one — the
      // latest — pending version per record.
      const now = new Date().toISOString();
      // Preserve the FIRST queue time when a device replaces its pending
      // customer draft. An Owner data reset uses that timestamp to reject a
      // stale offline push instead of letting it recreate a customer after the
      // database was intentionally cleared. `_queued_at` is client metadata;
      // syncService's column allow-list deliberately drops it before storage.
      const req = tx.objectStore(CUSTOMER_STORE).put(Object.assign({}, customer, {
        updated_at: now.replace('T', ' ').slice(0, 19),
        _queued_at: customer._queued_at || now,
      }));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllCustomerEdits() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOMER_STORE, 'readonly');
      const req = tx.objectStore(CUSTOMER_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function removeCustomerEdits(ids) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOMER_STORE, 'readwrite');
      const store = tx.objectStore(CUSTOMER_STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function customerEditCount() {
    return (await getAllCustomerEdits()).length;
  }

  // CHUNKED "BIT-BY-BIT" PUSH — implements Cloudflare's own documented
  // guidance for staying within the Workers/D1 free-tier ceilings (10ms
  // CPU-time/request, 100 bound parameters/query, 50 subrequests/
  // invocation): rather than push the whole pending-customer-edits queue
  // as one large request, this slices it into small batches (default 15
  // — comfortably under the server's own MAX_PUSH_ROWS_PER_TABLE=100
  // hard cap in syncService.js, leaving generous headroom) and pushes
  // one batch per request via POST /api/sync/push, stopping (and
  // leaving the rest queued for the next call) on the first failure —
  // e.g. the network drops mid-sync — so nothing is ever lost, and a
  // successful chunk is removed from the local queue immediately rather
  // than waiting for the entire, possibly-large, backlog to clear.
  // `sendChunkFn` is injected (rather than calling Api directly from
  // here) purely to avoid a circular module-load dependency between
  // offline.js and api.js — see its call site in api.js's
  // `pushCustomerQueue()`.
  async function processCustomerSyncQueue(sendChunkFn, batchSize = 15) {
    const pending = await getAllCustomerEdits();
    let ok = 0, failed = 0;
    for (let i = 0; i < pending.length; i += batchSize) {
      const chunk = pending.slice(i, i + batchSize);
      try {
        await sendChunkFn(chunk, pending.length - (i + chunk.length));
        await removeCustomerEdits(chunk.map((c) => c.id));
        ok += chunk.length;
      } catch (e) {
        failed += chunk.length;
        break; // stop and resume on the next sync cycle — do not skip ahead past a failed chunk
      }
    }
    return { ok, failed, remaining: (await customerEditCount()) };
  }

  return {
    enqueue, getAll, remove, count, flush, isBeyondSafeReplayWindow, IDEMPOTENCY_SAFE_DAYS,
    queueCustomerEdit, getAllCustomerEdits, removeCustomerEdits, customerEditCount, processCustomerSyncQueue,
    getAllFailed, removeFailed, retryFailed, failedCount,
  };
})();
// Printing and file export — receipts, reports, and financial records.
//
// WHY NATIVE PRINT INSTEAD OF A PDF LIBRARY (jsPDF/pdfmake):
//  1. public/_headers sets `script-src 'self'`, so a CDN-loaded PDF library is
//     blocked outright. Bundling one would add ~350 KB to the app shell that
//     every field device must cache offline, on Nigerian mobile data.
//  2. Every target platform already has a PDF writer built into its print
//     dialog: desktop Chrome/Firefox/Edge/Safari ("Save as PDF"), Android
//     Chrome ("Save as PDF" destination), iOS Safari (Share -> Print -> pinch,
//     or Share -> Save to Files). So "download as PDF" is one dialog away and
//     costs us nothing.
//  3. A browser-rendered PDF has SELECTABLE, SEARCHABLE text and real page
//     breaks. A canvas-rasterised jsPDF export is a flat image — useless to an
//     accountant who needs to copy a figure, and far heavier per page.
//  4. The same document also prints directly to paper and to thermal receipt
//     printers, which is what a pharmacy counter actually needs.
//
// CSV is offered alongside because a PDF is for reading and filing, while a
// spreadsheet is for reconciling. CSV opens natively in Excel, Google Sheets,
// LibreOffice and Numbers with no library on our side.
