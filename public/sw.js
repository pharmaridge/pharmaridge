// Service worker: app-shell caching for offline-first use.
// Note: API data itself is handled by the app's own IndexedDB-backed
// offline queue (see js/offline.js), not by this service worker —
// this SW only makes sure the UI loads with no network at all.
const CACHE_NAME = 'pharmaridge-v76';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/style.css',
  // Loaded render-blocking from <head> (see index.html) — it must be in the
  // shell or an offline launch paints the light theme first and then snaps to
  // dark once the cache serves it.
  '/js/theme.js',
  '/js/app.js',
  '/js/api.js',
  '/js/offline.js',
  '/js/router.js',
  '/js/state.js',
  '/js/deviceId.js',
  '/js/ui.js',
  '/js/branding.js',
  '/js/export.js',
  '/js/receipt.js',
  '/js/views/login.js',
  '/js/views/dashboard.js',
  '/js/views/pos.js',
  '/js/views/sales.js',
  '/js/views/stock.js',
  '/js/views/till.js',
  '/js/views/attendance.js',
  '/js/views/stocktake.js',
  '/js/views/customers.js',
  '/js/views/suppliers.js',
  '/js/views/products.js',
  '/js/views/purchaseOrders.js',
  '/js/views/transfers.js',
  '/js/views/expenses.js',
  '/js/views/controlledRegister.js',
  '/js/views/sync.js',
  '/js/views/users.js',
  '/js/views/accounting.js',
  '/js/views/plan.js',
  '/js/views/admin.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/branding/pharmaridge-logo.png',
  '/branding/pharmaridge-mark.png',
];


self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/manifest.json' || url.pathname === '/api/manifest.json') {
    // Never cache-first: this is a dynamic, per-deployment route
    // (server/app.js's /manifest.json + /api/manifest.json, or
    // worker/src/index.js's /api/manifest.json on the Cloudflare
    // deployment) that reflects the Admin Portal's current
    // business-name/logo branding, not a static file — a stale cached
    // copy would permanently show an old or default identity in the
    // "Add to Home Screen" install flow even after a client is
    // re-branded. Network-first with a safe offline fallback. Checked
    // BEFORE the generic /api/ passthrough below so it gets this
    // explicit cache-fallback behavior instead of the plain
    // no-service-worker-involvement treatment other /api/ calls get.
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    // Network-first for API calls; the app layer decides how to queue
    // failures for later sync.
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
