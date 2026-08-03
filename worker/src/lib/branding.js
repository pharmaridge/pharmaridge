// Deployment branding validation — Cloudflare Workers port of the original
// implementation Same validation rules (500 KB cap, real magic-byte sniff
// against the declared MIME type, PNG/JPEG/WEBP/GIF only — no SVG, which
// can carry scripts), implemented with Web- standard APIs
// (atob/Uint8Array) rather than Node's Buffer so this works identically
// whether or not the `nodejs_compat` compatibility flag ever changes. Kept
// deliberately parallel in structure/wording to the Node version so the
// two backends are easy to audit side by side.
const MAX_LOGO_DATA_URL_LENGTH = 500 * 1024; // 500 KB, generous for a small logo mark
const DATA_URL_RE = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const MAGIC_BYTES = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/jpg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38], // "GIF8" (covers GIF87a/GIF89a)
};

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesStartWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function bytesToAscii(bytes, start, end) {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function isValidWebp(bytes) {
  if (bytes.length < 12) return false;
  return bytesToAscii(bytes, 0, 4) === 'RIFF' && bytesToAscii(bytes, 8, 12) === 'WEBP';
}

// Throws a descriptive Error (caller maps it to a 400) if `dataUrl` is
// not a genuine, reasonably-sized image data: URL.
function assertValidLogoDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new Error('Logo must be a non-empty image data URL.');
  }
  if (dataUrl.length > MAX_LOGO_DATA_URL_LENGTH) {
    throw new Error(`Logo is too large (${Math.round(dataUrl.length / 1024)} KB) — please use an image under 500 KB.`);
  }
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) {
    throw new Error('Logo must be a PNG, JPEG, WEBP, or GIF image (as a base64 data URL).');
  }
  const mimeType = match[1];
  const base64 = match[3];
  let bytes;
  try {
    bytes = base64ToBytes(base64);
  } catch (e) {
    throw new Error('Logo data URL could not be decoded — the file may be corrupted.');
  }
  if (bytes.length === 0) {
    throw new Error('Logo data URL decoded to an empty file.');
  }
  const isWebp = mimeType === 'image/webp';
  const genuine = isWebp ? isValidWebp(bytes) : bytesStartWith(bytes, MAGIC_BYTES[mimeType] || []);
  if (!genuine) {
    throw new Error('The uploaded file does not appear to be a genuine image of the declared type — please try a different file.');
  }
}

module.exports = { assertValidLogoDataUrl, MAX_LOGO_DATA_URL_LENGTH };
