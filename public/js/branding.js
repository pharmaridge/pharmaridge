const Branding = (() => {
  const PRODUCT_NAME = 'PharmaRidge';
  let cached = null;

  async function load() {
    try {
      cached = await Api.get('/branding');
    } catch (e) {
      // Never let a branding fetch failure block the app from loading —
      // fall back to the default PharmaRidge identity.
      cached = { business_name: null, has_logo: false, logo_url: null };
    }
    apply();
    return cached;
  }

  function get() {
    return cached || { business_name: null, has_logo: false, logo_url: null };
  }

  // The name shown as THIS app's primary identity: the client's own
  // trading name once the Admin Portal has set one, otherwise the
  // PharmaRidge product name itself.
  function displayName() {
    return get().business_name || PRODUCT_NAME;
  }

  // "Powered by PharmaRidge" attribution — only meaningful (and only
  // shown) once a client has been white-labelled with their own
  // business name; showing "PharmaRidge — Powered by PharmaRidge" for
  // an unbranded deployment would be redundant, so this returns null in
  // that case and callers should render nothing.
  function poweredByLine() {
    return get().business_name ? `Powered by ${PRODUCT_NAME}` : null;
  }

  // PRINT ATTRIBUTION — always present, unlike poweredByLine().
  //
  // poweredByLine() deliberately returns null for an UNBRANDED deployment,
  // because "PharmaRidge — Powered by PharmaRidge" in the app chrome is
  // redundant. Paper is a different case: the client asked for the pharmacy's
  // own name as a bold header on every receipt and printout with "Powered by
  // PharmaRidge" subtle beneath it, and that attribution has to be there
  // whether or not a trading name has been set — it is what identifies the
  // software on a document that has left the building.
  //
  // Kept as its own function rather than changing poweredByLine(), because
  // the screen and the page genuinely want different answers to the same
  // question.
  function printAttribution() {
    return `Powered by ${PRODUCT_NAME}`;
  }

  // Applies the cached branding to every DOM element that shows the
  // product/business name or logo. Safe to call multiple times (e.g.
  // again right after an Admin Portal save) — always re-reads the
  // current DOM elements rather than caching references.
  function apply() {
    const b = get();
    const name = displayName();
    const poweredBy = poweredByLine();

    document.title = `${name} — Multi-Branch Pharmacy Management`;

    // FUNCTIONAL GAP (found during this audit's PWA capability pass):
    // #favicon-link has carried an `id` attribute since day one — a
    // strong signal it was meant to be dynamically updated to match a
    // client's own uploaded logo, exactly like #topbar-logo already is
    // below — but nothing ever actually touched it. A branded client's
    // browser tab (and, on many platforms, the PWA's own taskbar/dock
    // icon while running in a tab rather than fully installed) kept
    // showing the generic PharmaRidge icon forever, even after the
    // Admin Portal set their own logo — a real, visible branding
    // inconsistency between "the topbar/login screen show your logo"
    // and "the browser tab still shows ours". Fixed to mirror the
    // topbar logo's own has_logo/logo_url branching exactly.
    const faviconLink = document.getElementById('favicon-link');
    if (faviconLink) faviconLink.href = (b.has_logo && b.logo_url) ? b.logo_url : '/icons/icon-192.png';

    // iOS Safari reads <link rel="apple-touch-icon"> at the exact
    // moment a user taps "Add to Home Screen" — keeping it in sync
    // with the client's own branding means an iPhone/iPad install
    // shows their logo too, not just the generic PharmaRidge mark
    // (Android/desktop already gets this correctly via the dynamic
    // manifest.json route's `icons` array).
    const appleTouchIconLink = document.querySelector('link[rel="apple-touch-icon"]');
    if (appleTouchIconLink) appleTouchIconLink.href = (b.has_logo && b.logo_url) ? b.logo_url : '/icons/apple-touch-icon.png';

    // BUG 59 — BRANDING DESTROYED THE BRAND MARK AND RE-ADDED AN EMOJI.
    //
    // This wrote `topbarBrand.textContent = ...`, which replaces ALL child
    // nodes. #topbar-brand is not a text node: index.html ships it as an
    // inline SVG mark plus a <span> holding the words. textContent therefore
    // deleted both, every single time branding loaded — which is on every
    // page load, before anything is rendered. Two consequences, both live:
    //
    //  1. The <span> is what `@media (max-width: 560px) .brand > span
    //     { display: none }` targets, so once it was gone the brand text could
    //     no longer be hidden on a narrow phone and ran under the branch
    //     switcher. Confirmed by rendering at 390px: hasSpan:false and the
    //     words visibly clipped behind the select.
    //  2. The unbranded fallback re-introduced a 💊 EMOJI — the exact failure
    //     Bug 56 removed from the whole chrome, because a device with no emoji
    //     font renders it as a tofu box. A fix in one file was quietly undone
    //     by another file at runtime, which is why this only showed up in a
    //     rendered screenshot and never in source review.
    //
    // Now only the <span>'s text is replaced; the SVG mark is left alone.
    const topbarBrand = document.getElementById('topbar-brand');
    const topbarLogo = document.getElementById('topbar-logo');
    const hasClientLogo = !!(b.has_logo && b.logo_url);
    if (topbarBrand) {
      const brandText = topbarBrand.querySelector('span');
      if (brandText) brandText.textContent = b.business_name ? name : PRODUCT_NAME;
      else topbarBrand.textContent = b.business_name ? name : PRODUCT_NAME;
      // The default header mark is inline SVG and uses currentColor, so it
      // automatically inherits the header's foreground colour in either theme.
      // A client's uploaded logo intentionally replaces only that default.
      const navMark = topbarBrand.querySelector('.brand-ico');
      if (navMark) navMark.classList.toggle('hidden', hasClientLogo);
    }
    if (topbarLogo) {
      if (hasClientLogo) {
        topbarLogo.src = b.logo_url;
        topbarLogo.alt = name;
        topbarLogo.classList.remove('hidden');
      } else {
        topbarLogo.classList.add('hidden');
        topbarLogo.removeAttribute('src');
      }
    }

    const sidebarFooter = document.getElementById('sidebar-footer');
    if (sidebarFooter) {
      if (poweredBy) {
        sidebarFooter.textContent = poweredBy;
        sidebarFooter.classList.remove('hidden');
      } else {
        sidebarFooter.classList.add('hidden');
      }
    }
  }

  return { load, get, displayName, poweredByLine, printAttribution, apply, PRODUCT_NAME };
})();

// BUG 111 — `window.Branding` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.Branding && Branding.thing())` — a reasonable-looking defensive idiom that
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
window.Branding = Branding;
