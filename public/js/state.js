// Simple global state store with localStorage persistence for the
// session (token/user/branch) — the app-shell itself is cached by the
// service worker, and business data comes live from the API or the
// offline queue.
const State = (() => {
  const KEY = 'gl_pms_session';
  let session = null;
  try {
    session = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch (e) {
    session = null;
  }

  // For a MANAGER, `viewBranchId` (null = ALL branches) controls which
  // branch's data the dashboard/views currently show. Staff can't change
  // this — it's always forced to their own branch by the API layer.
  let viewBranchId = (session && session.viewBranchId) || null;

  function setSession(s) {
    session = s;
    persist();
  }
  function clearSession() {
    session = null;
    viewBranchId = null;
    localStorage.removeItem(KEY);
  }
  function getSession() {
    return session;
  }
  // Replaces just the `user` portion of an already-logged-in session
  // (full_name/role/branch_id/job_title) with a fresh copy read live
  // from the server, WITHOUT touching the token or forcing a re-login.
  // See app.js's refreshCurrentUser() for the real gap this closes:
  // a manager/owner deactivating, promoting, or renaming another
  // already-logged-in user previously had no way to ever reach that
  // user's own browser tab until their JWT naturally expired (up to
  // 12h later) or they manually logged out — is-active revocation was
  // enforced correctly server-side on every subsequent API call, but
  // role/name/branch changes were not, silently leaving a stale nav
  // menu and topbar label for the rest of that shift.
  function updateSessionUser(freshUser) {
    if (!session) return;
    session = Object.assign({}, session, { user: Object.assign({}, session.user, freshUser) });
    persist();
  }
  function setViewBranch(branchId) {
    viewBranchId = branchId || null;
    persist();
  }
  function getViewBranch() {
    return viewBranchId;
  }
  function persist() {
    // LEGACY-BROWSER COMPATIBILITY: object spread (`{...session}`) is
    // ES2018 syntax — written instead with `Object.assign()`, which has
    // been available since ES5/IE9, matching this file's overall
    // "avoid post-ES2015 syntax in anything shipped to the browser"
    // policy (see public/js/api.js's handleSessionExpired comment for
    // the full rationale).
    if (session) localStorage.setItem(KEY, JSON.stringify(Object.assign({}, session, { viewBranchId: viewBranchId })));
  }
  function isLoggedIn() {
    return !!(session && session.token);
  }
  function isManager() {
    return ['MANAGER', 'OWNER', 'ADMIN'].includes(session && session.user && session.user.role);
  }
  // BRANCH-SCOPED MANAGERS (migration 0003) — mirrors the server's
  // pinnedBranchIdOf() in worker/src/lib/auth.js exactly. A user is
  // pinned when their own row carries a branch_id: STAFF always, a
  // branch-scoped MANAGER optionally, never OWNER/ADMIN.
  function pinnedBranchId() {
    const u = session && session.user;
    if (!u) return null;
    if (u.role === 'OWNER' || u.role === 'ADMIN') return null;
    return u.branch_id || null;
  }
  function isBranchPinned() {
    return !!pinnedBranchId();
  }

  // BUG 97 — THE BRANCH A SCREEN SHOULD SHOW.
  //
  // Thirteen views computed this themselves as:
  //
  //     user.role === 'STAFF' ? user.branch_id : State.getViewBranch()
  //
  // which is wrong for a BRANCH MANAGER. Their role is 'MANAGER', so they fell
  // into the getViewBranch() arm — but a pinned manager is deliberately given
  // a scope LABEL instead of the branch switcher (app.js refreshBranchSwitcher),
  // so getViewBranch() is null for them and stays null. Five screens (POS,
  // Till, Stocktake, Transfers, Expenses) answered "Select a specific branch
  // to manage its till" to a person with no control capable of selecting one.
  // A dead end on the till screen for the very person who runs the shop.
  //
  // The rule is simply: a PINNED user is always scoped to their own branch;
  // everyone else follows the switcher. That is exactly pinnedBranchId(), which
  // already mirrors the server's pinnedBranchIdOf(), so this is one helper
  // rather than thirteen corrected ternaries — and the next view inherits it.
  function effectiveBranchId() {
    return pinnedBranchId() || getViewBranch();
  }
  // ROLE LABELS — mirrors roleLabel() in worker/src/lib/auth.js exactly.
  // The API already returns `role_label` on every user payload; this local
  // copy exists for the rare case of rendering a user object that did not
  // come from the API (and so a drift test asserts the two agree).
  //   General Manager -> MANAGER with no branch (org-wide)
  //   Branch Manager  -> MANAGER pinned to one branch
  function roleLabelOf(u) {
    if (!u || !u.role) return '';
    if (u.role === 'MANAGER') return u.branch_id ? 'Branch Manager' : 'General Manager';
    if (u.role === 'ADMIN') return 'PharmaRidge Support';
    if (u.role === 'OWNER') return 'Owner';
    if (u.role === 'STAFF') return 'Staff';
    return u.role;
  }
  function isOwner() {
    return !!(session && session.user && session.user.role === 'OWNER');
  }
  function isAdmin() {
    return !!(session && session.user && session.user.role === 'ADMIN');
  }

  return { setSession, clearSession, getSession, updateSessionUser, isLoggedIn, isManager, isOwner, isAdmin, roleLabelOf, pinnedBranchId, isBranchPinned, effectiveBranchId, setViewBranch, getViewBranch };
})();

// BUG 111 — `window.State` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.State && State.thing())` — a reasonable-looking defensive idiom that
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
window.State = State;
