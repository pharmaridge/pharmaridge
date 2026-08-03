// PharmaRidge icon builder — ONE artwork source, every shipped raster.
//
// WHY THIS FILE EXISTS
// --------------------
// The icon had been hand-generated twice and each round produced five PNGs
// with no source of truth behind them. Any later tweak meant regenerating
// five files by hand and hoping they matched. Trap #92 says an icon is a
// product decision; a product decision needs a build, not a one-off.
//
// Everything below derives from ONE `artwork()` function, so the 512, the
// 192, the two maskables, the apple-touch icon and the in-app topbar mark are
// the same geometry by construction.
//
// PALETTE: sampled from public/css/style.css :root, not invented.
//   --green-900 #0a3b2c  (topbar bg / PWA theme-color #0b3d2e)
//   --green-800 #0f4a37    --green-600 #1a7a52    --green-500 #22945f
//   --green-300 #7cc4a3    --amber-500 #d98c1f    --amber-600 #96600a
//
// FONT: Montserrat (system-installed at build time: `apt-get install
// fonts-montserrat`). The wordmark is forced to a fixed advance width with
// textLength/lengthAdjust, so if a machine substitutes a different face the
// lockup still occupies exactly the same box and cannot overflow the plinth.
//
// Usage: node test/tools/build-icons.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PUB = path.join(__dirname, '..', '..', '..', 'public');
const ICONS = path.join(PUB, 'icons');
const OUT = process.env.ICON_OUT || ICONS;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const C = {
  g900: '#0a3b2c',
  g800: '#0f4a37',
  g700: '#145c3f',
  g600: '#1a7a52',
  g500: '#22945f',
  g300: '#7cc4a3',
  ivory: '#f7f1e1',
  ivoryHi: '#fffdf6',
  snow: '#eaf7f0',
  gold: '#d98c1f',
  goldHi: '#f0c469',
  goldLo: '#96600a',
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
// A peak is an isoceles-ish triangle; the snow cap has to follow its OWN two
// edges or it floats off the rock. Computing the edge x at the cap's base y
// is the whole trick — done here rather than by eyeballing coordinates.
function peak(apexX, apexY, baseL, baseR, baseY) {
  return `M ${apexX} ${apexY} L ${baseR} ${baseY} L ${baseL} ${baseY} Z`;
}
function edgeX(apexX, apexY, baseX, baseY, y) {
  return apexX + ((y - apexY) / (baseY - apexY)) * (baseX - apexX);
}
// Jagged snow line between the two faces at height `capY`.
function snowCap(apexX, apexY, baseL, baseR, baseY, capY) {
  const lx = edgeX(apexX, apexY, baseL, baseY, capY);
  const rx = edgeX(apexX, apexY, baseR, baseY, capY);
  const w = rx - lx;
  const pts = [
    [lx, capY],
    [lx + w * 0.18, capY - w * 0.16],
    [lx + w * 0.32, capY + w * 0.05],
    [lx + w * 0.48, capY - w * 0.19],
    [lx + w * 0.63, capY + w * 0.06],
    [lx + w * 0.79, capY - w * 0.14],
    [rx, capY],
  ];
  return `M ${apexX} ${apexY} L ${pts.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join(' L ')} Z`;
}

// ---------------------------------------------------------------------------
// THE ARTWORK — 1024 x 1024 user units
// ---------------------------------------------------------------------------
// Reading order top to bottom: the compounding vessel (what a pharmacy DOES),
// a gold rule (the ledger line — this product is as much an accounting system
// as a POS), the ridge (the name, and the multi-branch estate: several peaks,
// one range), and the ridge stands ON the gold nameplate rather than beside
// it. That is the "integrated wordmark" decision: the word is load-bearing
// structure, so at 48px it reads as a deliberate gold plinth instead of as
// text that failed.
const PLINTH_Y = 806;      // top of the gold nameplate
// The ridge's feet are drawn 34 units BELOW the plate's top edge, then the
// plate is painted over them. Rock and metal therefore INTERLOCK instead of
// merely touching — the difference between a nameplate that belongs to the
// artwork and one that looks stuck on afterwards.
const BASE_Y = 840;

// COMPACT MODE exists for the maskable icon only — see svgMaskable().
// In compact mode the nameplate becomes a rounded PILL instead of a
// full-bleed band, and the ridge is pulled in to the pill's own width, so
// the entire lockup has a finite bounding box that can be fitted inside
// Android's safe circle. Full-bleed artwork cannot be made safe by scaling
// alone: the band runs to the edge by definition.
// Where the wordmark sits, in artwork units. Below the ridge's feet, with
// enough room under it for the gold hairline rule.
const NAME_Y = 928;
const COMPACT_L = 112;
const COMPACT_R = 912;

function artwork(compact = false) {
  const L = compact ? COMPACT_L : 66;
  const R = compact ? COMPACT_R : 966;
  const nx0 = compact ? COMPACT_L : 0;          // nameplate left
  const nx1 = compact ? COMPACT_R : 1024;       // nameplate right
  return `
  <defs>
    <!-- The ground is the APPLICATION's own topbar green (#0a3b2c) at its
         centre, lifted towards --green-700 at the top-left where the light
         falls and dropped below it at the bottom-right. Sampling the real
         chrome rather than inventing a green is what makes the icon sit
         beside the app instead of next to it. -->
    <linearGradient id="ground" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#16644a"/>
      <stop offset="46%"  stop-color="${C.g900}"/>
      <stop offset="100%" stop-color="#05231b"/>
    </linearGradient>
    <!-- A corner vignette. Barely visible on its own; the difference between
         a flat tile and something with a surface. -->
    <radialGradient id="vignette" cx="0.5" cy="0.42" r="0.78">
      <stop offset="60%"  stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.30"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.26" r="0.78">
      <stop offset="0%"   stop-color="#1d7d5b" stop-opacity="0.62"/>
      <stop offset="100%" stop-color="#1d7d5b" stop-opacity="0"/>
    </radialGradient>
    <!-- Vessel shading: a real bowl is lit from the upper left and its
         right flank falls into shadow. A single flat fill reads as a sticker;
         this is most of the difference between "clip-art" and "premium". -->
    <linearGradient id="bowl" x1="0.12" y1="0" x2="0.92" y2="1">
      <stop offset="0%"   stop-color="#fffdf6"/>
      <stop offset="42%"  stop-color="${C.ivory}"/>
      <stop offset="100%" stop-color="#cfc09c"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#efe6cf"/>
      <stop offset="42%"  stop-color="#fffdf7"/>
      <stop offset="100%" stop-color="#ddd0b0"/>
    </linearGradient>
    <!-- Struck-metal nameplate: highlight, body, then a darker toe so the
         band has thickness instead of being a flat rectangle. -->
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#f3bf5c"/>
      <stop offset="34%"  stop-color="#dd9422"/>
      <stop offset="76%"  stop-color="${C.gold}"/>
      <stop offset="100%" stop-color="#a86a0b"/>
    </linearGradient>
    <linearGradient id="peakFront" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0%"   stop-color="#2fb578"/>
      <stop offset="100%" stop-color="#147a4e"/>
    </linearGradient>
    <linearGradient id="peakBack" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0%"   stop-color="#93d4b6"/>
      <stop offset="100%" stop-color="#5fae8c"/>
    </linearGradient>
    <!-- The ground deepens towards the foot so the name has something to sit
         in. A hard-edged rect read as a stripe laid across the artwork; a
         fade belongs to the same surface. -->
    <linearGradient id="footFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#062a20" stop-opacity="0"/>
      <stop offset="45%"  stop-color="#062a20" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#04211a" stop-opacity="0.78"/>
    </linearGradient>
    <!-- The lower slope of each peak, in shadow. -->
    <linearGradient id="peakShade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%"   stop-color="#0d6743"/>
      <stop offset="100%" stop-color="#128054"/>
    </linearGradient>
  </defs>

  <!-- ground. Skipped in compact mode: the maskable paints its own full-bleed
       field, and a scaled-down ground rect would show as a lighter SQUARE
       patch floating inside it. -->
  ${compact ? '' : `<rect x="0" y="0" width="1024" height="1024" fill="url(#ground)"/>
  <rect x="0" y="0" width="1024" height="1024" fill="url(#glow)"/>
  <rect x="0" y="0" width="1024" height="1024" fill="url(#vignette)"/>`}

  <!-- ============ MORTAR & PESTLE ============ -->
  <!-- Pestle first so the bowl's rim overlaps its tip: the two read as one
       object rather than as a stick resting near a bowl. -->
  <g>
    <path d="M 632 198 L 556 296" stroke="#cdbf9c" stroke-width="54"
          stroke-linecap="round" fill="none"/>
    <path d="M 628 194 L 552 292" stroke="url(#rim)" stroke-width="46"
          stroke-linecap="round" fill="none"/>
    <circle cx="650" cy="170" r="52" fill="url(#rim)"/>
    <circle cx="637" cy="158" r="17" fill="#fffdf7" opacity="0.9"/>
  </g>

  <!-- bowl -->
  <path d="M 358 284 C 358 404, 424 466, 512 466 C 600 466, 666 404, 666 284 Z"
        fill="url(#bowl)"/>
  <!-- Inner shadow along the right flank — the single cheapest cue that the
       vessel is round rather than a flat semicircle. -->
  <path d="M 604 284 C 604 388, 566 448, 512 464 C 600 466, 666 404, 666 284 Z"
        fill="#000000" opacity="0.13"/>
  <!-- foot + base -->
  <rect x="476" y="462" width="72" height="32" fill="#d8cbab"/>
  <rect x="436" y="490" width="152" height="34" rx="15" fill="url(#rim)"/>
  <!-- rim last: it is the highest plane of the object -->
  <rect x="334" y="236" width="356" height="52" rx="24" fill="url(#rim)"/>
  <!-- Rim bevel: a bright top edge and a shadowed underside. This is what
       makes the lip read as a machined edge rather than a printed bar, and
       being geometry (not a blur) it survives being scaled to 48px. -->
  <rect x="352" y="243" width="320" height="10" rx="5" fill="#fffdf7" opacity="0.72"/>
  <rect x="348" y="279" width="328" height="7" rx="3.5" fill="#000000" opacity="0.10"/>

  <!-- Rx, cut out of the ivory in the ground colour -->
  <g fill="${C.g900}" font-family="Montserrat, 'DejaVu Sans', sans-serif">
    <text x="470" y="410" font-size="150" font-weight="700"
          text-anchor="middle" letter-spacing="-4">R</text>
    <text x="556" y="434" font-size="104" font-weight="600"
          text-anchor="middle">x</text>
  </g>

  <!-- ============ LEDGER RULE ============ -->
  <!-- The horizon. It must sit ABOVE every apex: at first pass the centre peak
       pierced it and the two elements read as a collision rather than as a
       skyline under a rule. Tapered ends stop it reading as a cut-off bar. -->
  <path d="M 286 570.5 L 306 566 H 718 L 738 570.5 L 718 575 H 306 Z" fill="${C.gold}"/>
  <path d="M 306 568 H 718 V 570.5 H 306 Z" fill="${C.goldHi}" opacity="0.75"/>

  <!-- ============ THE RIDGE ============ -->
  <!-- Three peaks: several shops, one range. Outer feet are clamped to the
       nameplate's own span so the compact lockup stays inside its box.
       Each peak gets a shadowed right slope and a snow cap that follows its
       own two edges. -->
  ${[
    { ax: compact ? 322 : 274, ay: 646, bl: L, br: compact ? 528 : 502, cap: 700, back: true },
    { ax: compact ? 726 : 776, ay: 672, bl: compact ? 538 : 558, br: R, cap: 722, back: true },
    { ax: 512, ay: 588, bl: compact ? 252 : 214, br: compact ? 780 : 812, cap: 676, back: false },
  ].map((k) => `
  <path d="${peak(k.ax, k.ay, k.bl, k.br, BASE_Y)}" fill="url(#${k.back ? 'peakBack' : 'peakFront'})"/>
  <path d="M ${k.ax} ${k.ay} L ${k.br} ${BASE_Y} L ${k.ax} ${BASE_Y} Z"
        fill="#000000" opacity="${k.back ? 0.1 : 0.14}"/>
  <path d="${snowCap(k.ax, k.ay, k.bl, k.br, BASE_Y, k.cap)}" fill="${C.snow}"/>`).join('')}

  <!-- Contact shadow where the ridge meets the ground. Without it the range
       and the field are two flat layers; with it they are one scene. -->
  ${compact ? '' : `<ellipse cx="512" cy="${BASE_Y - 4}" rx="470" ry="26" fill="#04211a" opacity="0.35"/>`}

  <!-- ============ THE NAME, SET INTO THE BACKGROUND ============ -->
  <!-- SIMPLER AND MORE PREMIUM — the client's brief, and a real correction.
       The previous lockup put PHARMARIDGE on a heavy gold plate across the
       foot of the icon. It was legible, but it was a BADGE bolted on beneath
       the artwork: two objects sharing a square, and the loudest thing in the
       composition was a slab of metal rather than the mark itself.
       Premium marks do the opposite. The name now sits IN the field — the
       same deep green ground the vessel and ridge stand on — as quiet
       letterforms with wide tracking, lit as though it were embossed into
       the surface: a fine dark cut above, a fine light edge below. Nothing
       is bolted on; the background carries the name.
       The gold survives as a single hairline rule under the word, which is
       the one place a metallic accent still earns its keep: it closes the
       composition and ties back to the ledger rule above the ridge. -->
  ${compact ? '' : `<rect x="0" y="${PLINTH_Y - 90}" width="1024" height="${1024 - PLINTH_Y + 90}" fill="url(#footFade)"/>`}

  <!-- Embossing: a dark cut sitting one unit ABOVE the face, and a light
       edge one unit BELOW it, so the letters read as pressed into the
       ground rather than printed on top of it. Two cheap offsets do what a
       filter would, and they survive being scaled to 48px. -->
  <text x="512" y="${NAME_Y - 2}" text-anchor="middle"
        font-family="Montserrat, 'DejaVu Sans', sans-serif"
        font-size="${compact ? 88 : 92}" font-weight="600" fill="#04231a"
        opacity="0.85" letter-spacing="${compact ? 8 : 11}"
        textLength="${compact ? 672 : 800}" lengthAdjust="spacingAndGlyphs">PHARMARIDGE</text>
  <text x="512" y="${NAME_Y + 2}" text-anchor="middle"
        font-family="Montserrat, 'DejaVu Sans', sans-serif"
        font-size="${compact ? 88 : 92}" font-weight="600" fill="#7cc4a3"
        opacity="0.30" letter-spacing="${compact ? 8 : 11}"
        textLength="${compact ? 672 : 800}" lengthAdjust="spacingAndGlyphs">PHARMARIDGE</text>
  <text x="512" y="${NAME_Y}" text-anchor="middle"
        font-family="Montserrat, 'DejaVu Sans', sans-serif"
        font-size="${compact ? 88 : 92}" font-weight="600" fill="#f5f0e6"
        letter-spacing="${compact ? 8 : 11}"
        textLength="${compact ? 672 : 800}" lengthAdjust="spacingAndGlyphs">PHARMARIDGE</text>

  <!-- The one surviving piece of gold: a hairline rule that closes the mark. -->
  <rect x="${512 - (compact ? 190 : 224)}" y="${NAME_Y + (compact ? 32 : 36)}"
        width="${compact ? 380 : 448}" height="3" rx="1.5" fill="${C.gold}" opacity="0.9"/>`;
}

// "any" icon — full bleed, the nameplate runs to the bottom edge.
function svgAny() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${artwork(false)}</svg>`;
}

// Maskable — Android crops to a circle/squircle and may eat 10% from EVERY
// side.
//
// BUG FOUND HERE BY RENDERING THE CROP RATHER THAN TRUSTING THE MATH.
// The first attempt scaled the FULL-BLEED artwork to 80% inside a green
// field. Under the inscribed-circle crop most launchers use it looked fine —
// which is exactly the trap. Under the STRICT documented safe zone (the
// centre 80% DIAMETER circle, radius 0.4w) the corners of the wordmark were
// sliced off and the icon read "HARMARIDG". Verified by compositing the real
// mask over the real PNG, not by inspecting coordinates.
//
// A full-bleed band cannot be made safe by scaling: it runs to the edge by
// definition, so its ends are always the first thing a circular crop eats.
// The fix is a different COMPOSITION, not a different scale — compact mode
// turns the nameplate into a pill with a finite bounding box, which is then
// fitted inside the safe circle by its own half-diagonal.
//
// CONTENT BOX of the compact lockup, in artwork units:
//   x: COMPACT_L .. COMPACT_R          (the pill, and the ridge clamped to it)
//   y: 118 (top of the pestle knob) .. 982 (bottom of the pill)
const MASK_BOX = { x0: COMPACT_L, y0: 118, x1: COMPACT_R, y1: 982 };
const SAFE_R = 1024 * 0.4;   // strict Android safe radius

function svgMaskable() {
  const bw = MASK_BOX.x1 - MASK_BOX.x0;
  const bh = MASK_BOX.y1 - MASK_BOX.y0;
  const bcx = (MASK_BOX.x0 + MASK_BOX.x1) / 2;
  const bcy = (MASK_BOX.y0 + MASK_BOX.y1) / 2;
  // Fit the box's own half-diagonal inside the safe circle, so EVERY corner
  // of the lockup — not just its edge midpoints — survives the crop.
  const halfDiag = Math.sqrt((bw / 2) ** 2 + (bh / 2) ** 2);
  const s = (SAFE_R * 0.985) / halfDiag;   // 1.5% margin for anti-aliasing
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect x="0" y="0" width="1024" height="1024" fill="${C.g900}"/>
  <g transform="translate(512 512) scale(${s.toFixed(5)}) translate(${-bcx} ${-bcy})">${artwork(true)}</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// The in-app topbar mark
// ---------------------------------------------------------------------------
// 20px on a #0a3b2c bar, with the word "PharmaRidge" ALREADY rendered beside
// it as live text. So this is not the icon shrunk: the ground and the
// nameplate are dropped (both would disappear into the bar), and what remains
// is the same silhouette — vessel over ridge — flattened to ONE colour that
// survives 20 physical pixels. Inline SVG: no extra request, already in the
// cached app shell, and `script-src 'self'` makes an external mark pointless.
//
// FIVE CANDIDATES WERE RENDERED AT 20px AND COMPARED SIDE BY SIDE against the
// mark actually shipping. Findings, in order, because each one cost a round:
//   * Reusing the app icon's own two-tone ridge FAILED: at .55 opacity on the
//     topbar green the ridge vanished and left a bowl floating on a smudge.
//     Opacity is not available as a design tool at this size.
//   * Three peaks FAILED: 6 vertices across ~14px is below one vertex per
//     pixel, so the teeth alias into a grey bar. Two peaks + a shoulder is the
//     most a 20px mark can carry.
//   * A deep ridge crowded the mortar's foot; a SHALLOWER, WIDER ridge reads
//     as ground under the vessel instead of as clutter beside it.
// `fill` (not `stroke`) throughout: a 1.8px stroke at 20px is a sub-pixel hair
// that the previous line-art mark rendered as pale grey rather than white.
const TOPBAR_SVG =
  '<svg class="brand-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<path d="M5.9 3.9h12.2v1.8a6.1 6.1 0 01-12.2 0z" fill="currentColor"/>'
  + '<path d="M11.35 10.2h1.3v1.3h-1.3z" fill="currentColor"/>'
  + '<path d="M9.4 11.4h5.2v1.3H9.4z" fill="currentColor"/>'
  + '<path d="M15.1 3.4l2.6-2.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
  + '<path d="M0.9 22.6l6.1-6.5 3.6 3.9 2.5-2.7 3.4 3.7 1.9-2.1 4.7 3.7z" fill="currentColor"/>'
  + '</svg>';

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
async function render(browser, svg, size, file) {
  const page = await browser.newPage();
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(
    `<html><body style="margin:0;padding:0;background:transparent">
     <div style="width:${size}px;height:${size}px;overflow:hidden">
     ${svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`)}
     </div></body></html>`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
  const target = path.join(OUT, file);
  await page.screenshot({ path: target, omitBackground: false });
  await page.close();
  return target;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });

  const any = svgAny();
  const mask = svgMaskable();

  const made = [];
  made.push(await render(browser, any, 1024, 'icon-source-frameless.png'));
  made.push(await render(browser, any, 512, 'icon-512.png'));
  made.push(await render(browser, any, 192, 'icon-192.png'));
  made.push(await render(browser, any, 180, 'apple-touch-icon.png'));
  made.push(await render(browser, mask, 512, 'icon-512-maskable.png'));
  made.push(await render(browser, mask, 192, 'icon-192-maskable.png'));

  // Contact sheet at the sizes a HUMAN actually sees, on both a light and a
  // dark page, plus the topbar mark on the real bar colour. Judging a logo at
  // 512px is judging it at a size no user will ever encounter.
  const sizes = [16, 24, 32, 48, 64, 96, 128, 192];
  const sheet = `<html><body style="margin:0;font-family:Montserrat,sans-serif">
    <div style="background:#ffffff;padding:18px">
      <div style="font-size:11px;color:#555;margin-bottom:8px">"any" on white</div>
      ${sizes.map((s) => `<span style="display:inline-block;text-align:center;margin-right:14px;vertical-align:bottom">
        <img src="data:image/svg+xml;base64,${Buffer.from(any).toString('base64')}" width="${s}" height="${s}"/>
        <div style="font-size:9px;color:#888">${s}</div></span>`).join('')}
    </div>
    <div style="background:#1b1f1d;padding:18px">
      <div style="font-size:11px;color:#aaa;margin-bottom:8px">"any" on dark</div>
      ${sizes.map((s) => `<span style="display:inline-block;text-align:center;margin-right:14px;vertical-align:bottom">
        <img src="data:image/svg+xml;base64,${Buffer.from(any).toString('base64')}" width="${s}" height="${s}"/>
        <div style="font-size:9px;color:#888">${s}</div></span>`).join('')}
    </div>
    <div style="background:#eef2f0;padding:18px">
      <div style="font-size:11px;color:#555;margin-bottom:8px">maskable, circle-cropped as Android will</div>
      ${[48, 64, 96, 192].map((s) => `<span style="display:inline-block;text-align:center;margin-right:14px;vertical-align:bottom">
        <img style="border-radius:50%" src="data:image/svg+xml;base64,${Buffer.from(mask).toString('base64')}" width="${s}" height="${s}"/>
        <div style="font-size:9px;color:#888">${s}</div></span>`).join('')}
    </div>
    <div style="background:#0a3b2c;color:#fff;padding:18px;display:flex;align-items:center;gap:9px">
      <span style="width:20px;height:20px;display:inline-flex">${TOPBAR_SVG.replace('class="brand-ico"', 'style="width:20px;height:20px"')}</span>
      <span style="font-weight:700;font-size:15.5px;letter-spacing:-.2px">PharmaRidge</span>
      <span style="margin-left:24px;font-size:11px;opacity:.6">topbar mark at its real 20px</span>
    </div>
  </body></html>`;
  const p = await browser.newPage();
  await p.setViewport({ width: 900, height: 900 });
  await p.setContent(sheet, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: '/tmp/icon-contact-sheet.png' });
  await p.close();

  await browser.close();

  fs.writeFileSync(path.join(__dirname, 'icon-source.svg'), any);

  // The topbar mark is WRITTEN INTO index.html by this build, not copied by
  // hand. Same discipline as build-manual.js reading the shipped icon-512
  // rather than a duplicate: if the two could be edited independently they
  // would eventually disagree, and the app chrome would show a different
  // logo from the install icon with nothing to catch it.
  if (OUT === ICONS) {
    const idx = path.join(PUB, 'index.html');
    const src = fs.readFileSync(idx, 'utf8');
    const re = /<svg class="brand-ico"[\s\S]*?<\/svg>/;
    if (!re.test(src)) {
      console.log('  WARNING: could not find .brand-ico in index.html — topbar mark NOT updated');
    } else {
      const next = src.replace(re, TOPBAR_SVG);
      if (next !== src) {
        fs.writeFileSync(idx, next);
        console.log('  index.html topbar mark   updated in place');
      } else {
        console.log('  index.html topbar mark   already current');
      }
    }
  }

  console.log('TOPBAR_SVG=' + TOPBAR_SVG);
  for (const f of made) {
    console.log(`  ${path.basename(f).padEnd(30)} ${(fs.statSync(f).size / 1024).toFixed(1)} KB`);
  }
  console.log('  contact sheet -> /tmp/icon-contact-sheet.png');
})();
