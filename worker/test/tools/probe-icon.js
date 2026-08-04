// probe-icon — the shipped icon rasters, measured rather than admired.
//
// WHY THIS PROBE EXISTS
// ---------------------
// The icon had been regenerated three times and never once TESTED. Each
// round was judged by looking at a 512px render, which is a size no user
// ever sees. That is how the maskable shipped with its wordmark sliced to
// "HARMARIDG" under Android's documented safe-zone crop: the inscribed-circle
// preview looked perfect, and the inscribed circle is not the guarantee.
//
// Everything here asserts an OUTCOME on the real PNG bytes (trap #43: assert
// intent, not implementation — so no check pins a coordinate or a file size).
//
// Run: node test/tools/probe-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUB = path.join(__dirname, '..', '..', '..', 'public');
const ICONS = path.join(PUB, 'icons');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---------------------------------------------------------------------------
// A dependency-free PNG reader. Pillow is not available to Node and adding an
// image library to devDependencies for six files is not worth it. PNG stores
// IHDR at a fixed offset, which is all that is needed for dimensions; pixel
// work is delegated to the Python helper the build already relies on.
// ---------------------------------------------------------------------------
function pngSize(file) {
  const b = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!b.subarray(0, 8).equals(sig)) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

// Full RGBA decode for 8-bit truecolour PNGs (colour type 2 and 6), which is
// what the icon build emits. Written out rather than pulled from npm: this
// probe must run in the same bare sandbox as everything else, and the pixel
// question being asked ("does the wordmark survive the crop") cannot be
// answered from file metadata.
function pngPixels(file) {
  const b = fs.readFileSync(file);
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  const bitDepth = b[24], colourType = b[25];
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) return null;
  const channels = colourType === 6 ? 4 : 3;

  const idat = [];
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));

  // Undo the per-scanline filters (PNG spec §6).
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a, bb, c) => {
    const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = (x >= channels && y > 0) ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) v += paeth(a, up, ul);
      out[y * stride + x] = v & 0xff;
    }
  }
  return {
    width, height, channels,
    at(x, y) {
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2], channels === 4 ? out[i + 3] : 255];
    },
  };
}

console.log('\n=== EVERY DECLARED ICON IS A REAL PNG AT ITS DECLARED SIZE ===');
// The manifest is the contract. Read the sizes FROM it rather than hardcoding
// them here, so adding an icon to the manifest cannot silently go untested.
const manifest = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.json'), 'utf8'));
for (const icon of manifest.icons) {
  const f = path.join(PUB, icon.src.replace(/^\//, ''));
  const s = fs.existsSync(f) ? pngSize(f) : null;
  check(`${icon.src} exists and is a real PNG`, !!s);
  if (!s) continue;
  const [w, h] = icon.sizes.split('x').map(Number);
  check(`${icon.src} is actually ${icon.sizes}`, s.width === w && s.height === h,
    `got ${s.width}x${s.height}`);
  // A PWA icon is fetched on install over Nigerian mobile data. 300 KB for a
  // 512px badge is not a hard error but it IS a regression worth failing on:
  // the pre-build hand-made file was 485 KB.
  check(`${icon.src} is under 300 KB`, s.bytes < 300 * 1024, `${(s.bytes / 1024).toFixed(0)} KB`);
}

const apple = path.join(ICONS, 'apple-touch-icon.png');
const as = fs.existsSync(apple) ? pngSize(apple) : null;
check('apple-touch-icon.png is a real PNG', !!as);
// index.html declares sizes="180x180"; iOS scales anything else and softens it.
if (as) {
  const declared = /apple-touch-icon"\s+sizes="(\d+)x\1"/.exec(fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'));
  check('apple-touch-icon matches the size index.html declares',
    !!declared && as.width === Number(declared[1]) && as.height === Number(declared[1]),
    `file ${as.width}x${as.height}, declared ${declared ? declared[1] : 'none'}`);
}

console.log('\n=== THE CANONICAL PREMIUM MARK IS WIRED INTO THE APPLICATION ===');
{
  const full = pngPixels(path.join(PUB, 'branding', 'pharmaridge-logo.png'));
  const pwaFull = pngPixels(path.join(PUB, 'branding', 'pharmaridge-pwa-logo.png'));
  const mark = pngPixels(path.join(PUB, 'branding', 'pharmaridge-mark.png'));
  check('the transparent full PHARMARIDGE lockup decodes', !!full);
  check('the prompt-derived transparent PWA lockup decodes', !!pwaFull);
  check('the transparent mountain/mortar application mark decodes', !!mark);
  for (const [label, image] of [['application logo', full], ['PWA source logo', pwaFull]]) {
    if (!image) continue;
    let visible = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.at(x, y)[3] > 15) visible++;
    check(`${label} has true transparent surroundings`, image.at(0, 0)[3] === 0, `corner alpha=${image.at(0, 0)[3]}`);
    check(`${label} has substantial visible artwork`, visible > image.width * image.height * 0.20, `${visible} visible pixels`);
  }
  const brandingSrc = fs.readFileSync(path.join(PUB, 'js', 'branding.js'), 'utf8');
  const loginSrc = fs.readFileSync(path.join(PUB, 'js', 'views', 'login.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  check('top navigation keeps an inline SVG mark', /<svg class="brand-ico"/.test(html));
  check('top navigation SVG inherits its foreground via currentColor', /<svg class="brand-ico"[\s\S]*?fill="currentColor"/.test(html));
  check('topbar branding preserves the SVG mark without a client logo', brandingSrc.includes("navMark.classList.toggle('hidden', hasClientLogo)"));
  check('login branding uses the full premium lockup', loginSrc.includes('/branding/pharmaridge-logo.png'));
  check('login has an animated SVG submit-progress state', loginSrc.includes('login-submit-spinner') && loginSrc.includes('Signing in…'));
}

console.log('\n=== THE MASKABLE ICON SURVIVES ANDROID\'S STRICT SAFE-ZONE CROP ===');
{
  // Android composites transparent PWA icon pixels against black on some
  // launchers, producing the visible black square that this app previously
  // showed on its splash screen. The shipped icon canvas is therefore the
  // SAME opaque #0a3b2c as manifest.background_color; only pixels that differ
  // from that background count as artwork for safe-zone measurement.
  const expectedBg = [10, 59, 44];
  for (const f of ['icon-512-maskable.png', 'icon-192-maskable.png']) {
    const p = pngPixels(path.join(ICONS, f));
    check(`${f} decodes to pixels`, !!p);
    if (!p) continue;
    const bg = p.at(0, 0);
    const isBg = (px) => px[3] > 250 && Math.max(Math.abs(px[0] - expectedBg[0]), Math.abs(px[1] - expectedBg[1]), Math.abs(px[2] - expectedBg[2])) <= 6;
    check(`${f} uses the seamless dark-green splash background`, isBg(bg), `corner rgba(${bg})`);
    const cx = p.width / 2, cy = p.height / 2, r = p.width * 0.4;
    let outside = 0, total = 0, worst = 0;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const px = p.at(x, y);
        if (isBg(px)) continue;
        total++;
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) { outside++; worst = Math.max(worst, d / (p.width * 0.5)); }
      }
    }
    check(`${f} has visible artwork at all`, total > p.width * p.height * 0.02, `${total} artwork px`);
    check(`${f} keeps ALL artwork inside the 80% safe circle`, outside === 0,
      `${outside} px outside; furthest ink at ${(worst * 100).toFixed(1)}% of the radius`);
  }

  for (const f of ['icon-512.png', 'icon-192.png']) {
    const p = pngPixels(path.join(ICONS, f));
    if (!p) { check(`${f} decodes to pixels`, false); continue; }
    const bg = p.at(0, 0);
    const isBg = (px) => px[3] > 250 && Math.max(Math.abs(px[0] - expectedBg[0]), Math.abs(px[1] - expectedBg[1]), Math.abs(px[2] - expectedBg[2])) <= 6;
    let artwork = 0;
    for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) if (!isBg(p.at(x, y))) artwork++;
    check(`${f} blends into the dark-green PWA splash`, isBg(bg), `corner rgba(${bg})`);
    check(`${f} has legible-sized visible artwork`, artwork > p.width * p.height * 0.06, `${artwork} artwork pixels`);
  }
}

console.log('\n=== THE FULL WORDMARK REMAINS PART OF THE PRIMARY LOGO ===');
{
  const p = pngPixels(path.join(PUB, 'branding', 'pharmaridge-logo.png'));
  check('full brand lockup decodes to pixels', !!p);
  if (p) {
    let lightInk = 0;
    const from = Math.floor(p.height * 0.68);
    for (let y = from; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const px = p.at(x, y);
        if (px[3] > 15 && px[0] > 200 && px[1] > 200 && px[2] > 185) lightInk++;
      }
    }
    const band = p.width * (p.height - from);
    const share = lightInk / band;
    check('PHARMARIDGE wordmark occupies real space in the full lockup', share > 0.10,
      `${(share * 100).toFixed(1)}% of the lower band is lettering`);
  }
}

console.log('\n=== THE SERVICE WORKER WILL ACTUALLY SHIP THE NEW ICONS ===');
{
  // Changing an icon without bumping the cache means every already-installed
  // device keeps the old one indefinitely — the change ships to nobody.
  const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
  for (const icon of manifest.icons) {
    check(`${icon.src} is in the service worker app shell`, sw.includes(icon.src));
  }
  check('apple-touch-icon is in the app shell too', sw.includes('/icons/apple-touch-icon.png'));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
