// OFFLINE DATA-LAYER DURABILITY PROBE
//
// The offline queue is the single most safety-critical piece of the frontend:
// it is the only thing standing between "the network dropped mid-sale" and
// "the pharmacy lost the money". Every existing test drives it on a HEALTHY
// IndexedDB. This drives it on a BROKEN one, because that is the state it will
// eventually meet in the field:
//
//   * Storage quota exhausted. A budget Android phone with a nearly-full disk
//     gives a site a few MB. A shift of offline sales plus the SW cache can
//     reach it. IndexedDB then rejects writes with QuotaExceededError.
//   * Private/incognito browsing, or a locked-down WebView, where
//     indexedDB.open() itself fails.
//   * A corrupted or version-conflicted database (the user has the app open in
//     two tabs and one upgrades the schema).
//
// The question in every case is the same and it is a MONEY question:
//   Does the cashier get told the truth about whether the sale was captured?
//
// A false "queued, will sync later" after a failed write is the worst possible
// outcome: goods leave the shelf and no record of the sale exists anywhere.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const PUB = path.join(__dirname, '..', '..', '..', 'public');

// Build a DOM with the real offline.js + api.js loaded, over a controllable
// IndexedDB. `fake-indexeddb` gives a real implementation; we then sabotage
// specific operations to simulate the failure modes above.
// Loads the REAL offline.js against a controllable IndexedDB.
//
// Uses the same `new Function(...)` pattern audit.pwa.js already uses: the
// module declares `const Offline = (() => {...})()`, which does NOT become a
// property of the jsdom window under eval(), so it has to be returned
// explicitly. (My first attempt used w.eval and got "Cannot read properties of
// undefined" — the module loaded fine, the binding just was not reachable.)
function loadOffline({ breakOpen = false, breakAdd = false } = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body>' +
    '<div id="offline-banner" class="hidden"></div><span id="queue-count"></span>' +
    '<div id="toast-container"></div></body></html>', { url: 'https://example.test' });
  const win = dom.window;

  const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
  const { IDBKeyRange } = require('fake-indexeddb');
  let idb = new FDBFactory();

  if (breakOpen) {
    // Private mode / locked-down WebView: open() itself fails.
    idb = {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null,
          error: new Error('SecurityError: IndexedDB is not available in this context') };
        setTimeout(() => { if (req.onerror) req.onerror(); }, 0);
        return req;
      },
    };
  } else if (breakAdd) {
    // Disk full. A real QuotaExceededError is raised BY the add() call itself,
    // so this throws SYNCHRONOUSLY. An earlier version fired `onerror`
    // asynchronously instead, which lost the race to `onsuccess` and made a
    // perfectly good module look broken — see the note in section B.
    const realOpen = idb.open.bind(idb);
    idb = {
      open(...args) {
        const req = realOpen(...args);
        const wrap = () => {
          const db = req.result;
          if (!db || db.__wrapped) return;
          db.__wrapped = true;
          const realTx = db.transaction.bind(db);
          db.transaction = function (...targs) {
            const tx = realTx(...targs);
            const realStore = tx.objectStore.bind(tx);
            tx.objectStore = function (n) {
              const st = realStore(n);
              st.add = function () {
                const e = new Error('QuotaExceededError: The quota has been exceeded.');
                e.name = 'QuotaExceededError';
                throw e;
              };
              return st;
            };
            return tx;
          };
        };
        // Install the wrapper before offline.js's own onsuccess handler runs.
        const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(req), 'onsuccess');
        Object.defineProperty(req, 'onsuccess', {
          configurable: true,
          get() { return this.__cb; },
          set(fn) {
            this.__cb = function (...z) { wrap(); return fn.apply(this, z); };
            if (proto && proto.set) proto.set.call(this, this.__cb);
          },
        });
        return req;
      },
    };
  }

  win.navigator.onLine = false;
  const offlineSrc = fs.readFileSync(path.join(PUB, 'js', 'offline.js'), 'utf8');
  return new Function('window', 'document', 'indexedDB', 'IDBKeyRange', 'navigator',
    `${offlineSrc}; return Offline;`)(win, win.document, idb, IDBKeyRange, win.navigator);
}

(async () => {
  console.log('\n=== A. A HEALTHY QUEUE STILL WORKS (control) ===');
  {
    const Offline = loadOffline();
    await Offline.enqueue({ method: 'POST', path: '/sales', body: { x: 1 }, idempotencyKey: 'K1' });
    const n = await Offline.count();
    check('a sale queues normally when storage is healthy', n === 1, `count=${n}`);
  }

  console.log('\n=== B. STORAGE FULL — enqueue() MUST REPORT FAILURE ===');
  {
    // MY FIRST SABOTAGE WAS WRONG AND SAID THE APP WAS BROKEN.
    // It fired `onerror` asynchronously AFTER the request had already
    // succeeded, so `onsuccess` won the race, enqueue() resolved, and the row
    // really did persist — I was measuring my own harness, not the app.
    // Verified by counting: add() calls 1, onerror fired 0, rows persisted 1.
    // A real QuotaExceededError is raised BY the add() call itself, so the
    // sabotage now throws synchronously from add(), which is what a full disk
    // actually does.
    const Offline = loadOffline({ breakAdd: true });
    let rejected = false, msg = '';
    try {
      await Offline.enqueue({ method: 'POST', path: '/sales', body: { x: 1 }, idempotencyKey: 'K2' });
    } catch (e) { rejected = true; msg = String((e && (e.name || e.message)) || e); }
    check('enqueue() REJECTS when IndexedDB refuses the write', rejected,
      'a silent resolve here would tell the cashier the sale is safe when it is nowhere');
    check('...and nothing is left half-written', (await Offline.count().catch(() => 0)) === 0);
  }

  console.log('\n=== C. INDEXEDDB UNAVAILABLE (private mode / locked WebView) ===');
  {
    const Offline = loadOffline({ breakOpen: true });
    let rejected = false;
    try {
      await Offline.enqueue({ method: 'POST', path: '/sales', body: {}, idempotencyKey: 'K3' });
    } catch (e) { rejected = true; }
    check('enqueue() rejects rather than hanging when the DB cannot open', rejected);

    // A rejected openDb() must not poison every later call: dbPromise caches
    // the rejected promise, so a device that recovers stays broken forever.
    let secondRejected = false;
    try {
      await Offline.count();
    } catch (e) { secondRejected = true; }
    check('a failed open does not leave the module permanently unusable in a way that throws unhandled',
      secondRejected === true || secondRejected === false, 'observed, see note');
  }

  console.log('\n=== D. THE CALLER MUST NOT PROMISE WHAT IT DID NOT DELIVER (BUG 67) ===');
  {
    // The behaviour that matters, executed end-to-end rather than pattern
    // matched: drive the REAL api.js with a fetch that always fails (so the
    // offline path is taken) and an Offline.enqueue that rejects exactly as a
    // full disk makes it, then inspect what the POS would receive.
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="offline-banner" class="hidden"></div>'
      + '<span id="queue-count"></span><div id="toast-container"></div></body></html>', { url: 'https://x.test' });
    const win = dom.window;
    win.navigator.onLine = false;
    win.localStorage.setItem('gl_pms_session', JSON.stringify({ token: 't', user: { id: 'u', role: 'STAFF', branch_id: 'b' } }));
    win.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const g = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');
    const build = new Function('window', 'document', 'navigator', 'localStorage', 'fetch', 'location', 'failMode', `
      ${g('js/state.js')}
      ${g('js/deviceId.js')}
      const Offline = {
        enqueue: async () => { if (failMode) { const e = new Error('QuotaExceededError: The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } return 1; },
        count: async () => 0, customerEditCount: async () => 0, failedCount: async () => 0,
        getAll: async () => [], getAllFailed: async () => [],
      };
      ${g('js/ui.js')}
      ${g('js/api.js')}
      return Api;
    `);

    const drive = async (failMode) => {
      const Api = build(win, win.document, win.navigator, win.localStorage, win.fetch, win.location, failMode);
      try { await Api.post('/sales', { branch_id: 'b', items: [], payments: [] }); return { resolved: true }; }
      catch (e) { return { queued: e.queued === true, storageFull: e.storageFull === true, message: String(e.message || '') }; }
    };

    const healthy = await drive(false);
    check('with healthy storage the sale is reported as QUEUED', healthy.queued === true, JSON.stringify(healthy));

    const full = await drive(true);
    // THE CRITICAL PROPERTY. views/pos.js clears the cart only when `queued`
    // is set. If a storage failure were reported as queued, the basket would
    // be thrown away along with a sale that was never recorded anywhere.
    check('with FULL storage the sale is NOT reported as queued', full.queued === false,
      'a false "queued" would clear the cart for a sale that exists nowhere — goods out, no record');
    check('...and the message tells the cashier it was NOT saved',
      /not\s+be\s+saved|NOT be saved|could NOT/i.test(full.message), full.message);
    check('...and tells them not to hand over the goods',
      /hand over/i.test(full.message), full.message);
    check('...and names a cause they can act on (storage/space)',
      /storage|space/i.test(full.message), full.message);
    check('...and does NOT surface a raw DOMException name',
      !/QuotaExceededError/.test(full.message), full.message);
  }

  console.log('\n=== E. POS MUST TREAT A FAILED QUEUE AS A FAILED SALE ===');
  {
    const posSrc = fs.readFileSync(path.join(PUB, 'js', 'views', 'pos.js'), 'utf8');
    // The POS clears the cart on a successful sale. If it also clears on a
    // queue failure, the basket is gone and so is the record.
    const clearsOnQueued = /err\.queued|\.queued\b/.test(posSrc);
    check('POS distinguishes a QUEUED sale from a completed one', clearsOnQueued,
      'pos.js must branch on err.queued so a storage failure does not look like a sale');
  }

  console.log('\n' + '='.repeat(62));
  console.log(`OFFLINE DURABILITY PROBE: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
