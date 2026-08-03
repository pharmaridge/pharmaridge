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
      return [out[i], out[i + 1], out[i + 2]];
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

console.log('\n=== THE TOPBAR MARK IN index.html IS THE ONE THE BUILD PRODUCES ===');
{
  // The topbar mark used to be hand-written in index.html with no relationship
  // to the icon build. Two artefacts that must agree, edited independently,
  // will eventually disagree — so the build now writes index.html, and this
  // asserts the file on disk still matches what the build would emit. It
  // compares the RENDERED GEOMETRY (the `d` attributes), not the whole string,
  // so reformatting the tag is not a failure.
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const inHtml = /<svg class="brand-ico"[\s\S]*?<\/svg>/.exec(html);
  check('index.html still contains a .brand-ico mark', !!inHtml);
  const builderSrc = fs.readFileSync(path.join(__dirname, 'build-icons.js'), 'utf8');
  const builderPaths = [...builderSrc.matchAll(/'<path d="([^"]+)"/g)].map((m) => m[1]);
  if (inHtml) {
    const htmlPaths = [...inHtml[0].matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
    check('the topbar mark has geometry (not an empty svg)', htmlPaths.length > 0);
    check('every path in index.html comes from build-icons.js',
      htmlPaths.every((d) => builderPaths.includes(d)),
      htmlPaths.filter((d) => !builderPaths.includes(d)).join(' | ').slice(0, 120));
    // A 20px mark drawn with hairline strokes renders grey, not white — the
    // exact defect in the mark this replaced. Solid fills are the requirement.
    check('the topbar mark is built from FILLS, not hairline strokes',
      (inHtml[0].match(/fill="currentColor"/g) || []).length >= 3,
      `${(inHtml[0].match(/fill="currentColor"/g) || []).length} filled paths`);
    check('the topbar mark inherits currentColor (works in both themes)',
      !/fill="#/.test(inHtml[0]) && !/stroke="#/.test(inHtml[0]));
  }
}

console.log('\n=== THE MASKABLE SURVIVES ANDROID\'S STRICT SAFE-ZONE CROP ===');
{
  // THE BUG THIS SECTION WAS WRITTEN FOR.
  // A maskable icon is guaranteed only the centre 80% DIAMETER circle
  // (radius 0.4 x width). Everything outside may be cropped by the launcher.
  // The first build of this lockup put the wordmark on a full-bleed band, so
  // the strict crop cut its first and last letters and the home screen read
  // "HARMARIDG". It passed an inscribed-circle preview, which is why the
  // preview is not the test.
  //
  // Assert the OUTCOME: no ink of the lockup may fall outside the safe
  // circle. Ink is anything that is not the flat background colour, which is
  // read from the corner rather than hardcoded.
  for (const f of ['icon-512-maskable.png', 'icon-192-maskable.png']) {
    const p = pngPixels(path.join(ICONS, f));
    check(`${f} decodes to pixels`, !!p);
    if (!p) continue;
    const bg = p.at(0, 0);
    const isBg = (px) => Math.max(Math.abs(px[0] - bg[0]), Math.abs(px[1] - bg[1]), Math.abs(px[2] - bg[2])) <= 14;
    const cx = p.width / 2, cy = p.height / 2, r = p.width * 0.4;
    let outside = 0, total = 0, worst = 0;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        if (isBg(p.at(x, y))) continue;
        total++;
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) { outside++; worst = Math.max(worst, d / (p.width * 0.5)); }
      }
    }
    check(`${f} has visible artwork at all`, total > p.width * p.height * 0.05, `${total} ink px`);
    check(`${f} keeps ALL artwork inside the 80% safe circle`, outside === 0,
      `${outside} px outside; furthest ink at ${(worst * 100).toFixed(1)}% of the radius`);
  }

  // The non-maskable icons are the opposite contract: they are NOT cropped,
  // so they should use the full square edge to edge.
  //
  // THIS CHECK USED TO REQUIRE A GOLD NAMEPLATE AT THE BOTTOM EDGE. That
  // pinned one particular DESIGN rather than the property that matters, and
  // it went red the moment the wordmark was moved into the background — a
  // deliberate improvement (simpler, less bolted-on). Trap #43 again, so it
  // now asserts the intent: the artwork must reach the edge, whatever the
  // artwork happens to be.
  for (const f of ['icon-512.png', 'icon-192.png']) {
    const p = pngPixels(path.join(ICONS, f));
    if (!p) { check(`${f} decodes to pixels`, false); continue; }
    const corner = p.at(1, 1);
    const bottom = p.at(Math.floor(p.width / 2), p.height - 1);
    const isBackgroundish = (px) => px[1] > px[0] && px[1] > px[2]; // green-dominant
    check(`${f} is full-bleed artwork with no white margin`,
      isBackgroundish(corner) && isBackgroundish(bottom),
      `corner rgb(${corner}) bottom rgb(${bottom})`);
  }
}

console.log('\n=== THE WORDMARK IS PRESENT, AND IS THE CLIENT\'S DECISION ===');
{
  // The client asked for "PharmaRidge within the logo" at every size. A
  // wordmark that is present in the source but invisible once rasterised at
  // 192 would satisfy the letter of that and not the intent. The nameplate is
  // the wordmark's carrier, so require the gold band to occupy a real share
  // of the icon at the SMALLEST size that ships.
  const p = pngPixels(path.join(ICONS, 'icon-192.png'));
  check('icon-192.png decodes to pixels', !!p);
  if (p) {
    // The wordmark is now LIGHT letterforms set into the dark ground, rather
    // than dark ink on a gold plate. What must be true is unchanged: at the
    // smallest size that ships, there is real, legible-sized lettering in the
    // lower third. Measuring the LETTERS directly is closer to the intent
    // than measuring the slab they used to sit on.
    let lightInk = 0;
    for (let y = Math.floor(p.height * 0.80); y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const px = p.at(x, y);
        // ivory/near-white letterforms on the deep green field
        if (px[0] > 200 && px[1] > 200 && px[2] > 185) lightInk++;
      }
    }
    const band = p.width * Math.ceil(p.height * 0.20);
    const share = lightInk / band;
    check('the wordmark occupies real space at 192px, not a hairline',
      share > 0.05, `${(share * 100).toFixed(1)}% of the lower band is lettering`);
    check('...and it is set into the background, not on a gold slab',
      (() => {
        let gold = 0;
        for (let y = Math.floor(p.height * 0.80); y < p.height; y++) {
          for (let x = 0; x < p.width; x++) {
            const px = p.at(x, y);
            if (px[0] > 150 && px[1] > 90 && px[1] < 190 && px[2] < 90) gold++;
          }
        }
        return gold / band < 0.25;   // a hairline rule is fine; a slab is not
      })(), 'the lower band is mostly gold — the wordmark is on a plate again');
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
