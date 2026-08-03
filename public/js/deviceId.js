// Persistent per-browser device identifier for REGISTERED_DEVICE
// attendance mode (see the rationale below).
// Generated once and stored in localStorage — this is the honest,
// industry-standard equivalent of "identify this laptop": no web browser
// exposes a real hardware serial number or MAC address to JavaScript
// (blocked for privacy by every modern browser engine), so nothing running
// in a browser — this app included — can read one. What CAN be done, and
// what commercial POS terminal-locking features actually rely on under the
// hood, is a random ID generated once and persisted client-side, uniquely
// identifying "this browser profile on this machine" for as long as no one
// clears site data or switches browsers/profiles on it.
const DeviceId = (() => {
  const KEY = 'gl_pms_device_id';

  function get() {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  }

  return { get };
})();
// Deployment branding — fetches /api/branding (public, unauthenticated;
// available even before login, since the login screen itself needs to
// show the client's own business name/logo) and applies it consistently
// everywhere the software's own "PharmaRidge" name/mark would otherwise
// show: the browser tab title, the topbar, the login screen, and a
// small "Powered by PharmaRidge" attribution wherever the client has
// set their own trading name. Cached in-memory for the page's lifetime
// — App.init() fetches it once on load; renderLogin()/other chrome
// reuse the cached value rather than re-fetching on every navigation.
