// Password hashing and JWT signing/verification using the Web Crypto
// API — deliberately NOT bcryptjs/jsonwebtoken (the Node/Express
// deployment's choices), because:
//   1. Neither is Node-API-free; jsonwebtoken in particular pulls in
//      Node's `crypto` module in ways that don't map cleanly onto the
//      Workers runtime's subset, and
//   2. bcrypt's whole design goal is to BE slow (deliberately expensive
//      per-hash, to resist brute force) — which is exactly the wrong
//      property on a platform whose free tier gives a Worker only 10ms
//      of CPU time for the ENTIRE request (routing, JSON parsing, the
//      D1 query, AND the hash all share that one 10ms budget). A bcrypt
//      hash at any sane cost factor, or even a strong PBKDF2 iteration
//      count, would blow through that budget by itself before the rest
//      of the request ever ran.
//
// The iteration count below (PBKDF2_ITERATIONS) is a deliberate,
// measured trade-off, not a guess — see the benchmark note next to the
// constant. If this app is deployed on a paid Workers plan
// ($5/mo, which removes the 10ms ceiling — see DEPLOYMENT.md), raise
// PBKDF2_ITERATIONS to a stronger value such as 210,000 (OWASP's
// current PBKDF2-SHA256 recommendation) with no other code changes:
// the stored hash format embeds its own iteration count per-record, so
// existing hashes keep verifying correctly even after you raise it for
// new ones (see hashPin/verifyPin below).
//
// Benchmarked with Node's Web Crypto implementation (the same V8
// SubtleCrypto primitive the Workers runtime uses) on this project's
// dev machine: ~4ms at 20,000 iterations, ~19ms at 100,000 iterations.
// 20,000 was chosen to leave headroom, within the free plan's 10ms
// total request budget, for routing + JSON parsing + the D1 round-trip
// that also have to happen in the same request.
const PBKDF2_ITERATIONS = 20000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, HASH_BYTES * 8);
  // Stored format: pbkdf2$<iterations>$<salt-hex>$<hash-hex>
  // Versioned so the iteration count can be raised later without
  // breaking verification of PINs hashed under the old count.
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

async function verifyPin(pin, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) return false;
  const [, iterationsStr, saltHex, hashHex] = stored.split('$');
  const iterations = Number(iterationsStr);
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, HASH_BYTES * 8);
  const computedHex = toHex(bits);
  // Constant-time comparison to avoid leaking hash-match progress via
  // response-time side channel.
  return timingSafeEqual(computedHex, hashHex);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// --- JWT (HMAC-SHA256) ---------------------------------------------
function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getHmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12 hours; renewed in-flight by the sliding session in lib/auth.js

async function signToken(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  // `iat`/`exp` stay whole seconds, as the JWT spec requires.
  //
  // BUG 49: `iat` alone cannot decide whether a token was minted before or
  // after a credential change that happened in the SAME second — a stale
  // token minted at N.000 and a fresh one minted at N.950 carry an
  // identical iat and are indistinguishable. Proven directly: with
  // second-resolution comparison, one of the two answers is always wrong —
  // either the compromised session survives, or the user's own immediate
  // re-login with the new PIN is rejected.
  //
  // `imt` (issued-at, milliseconds) is a private claim carrying the
  // precision needed to separate them. It is additive, so any token
  // already in the wild simply lacks it and falls back to the conservative
  // second-based comparison in lib/auth.js.
  const fullPayload = { ...payload, iat: nowSeconds, imt: nowMs, exp: nowSeconds + TOKEN_TTL_SECONDS };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// Verifies signature AND expiry. Throws on any failure — callers should
// catch and respond 401, never trust a token that fails this.
async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await getHmacKey(secret);
  const signatureValid = await crypto.subtle.verify('HMAC', key, base64UrlDecode(encodedSignature), new TextEncoder().encode(signingInput));
  if (!signatureValid) throw new Error('Invalid signature');
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && nowSeconds >= payload.exp) throw new Error('Token expired');
  return payload;
}

// --- General-purpose helpers -----------------------------------------
function uuid() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

module.exports = { hashPin, verifyPin, signToken, verifyToken, uuid, sha256Hex, PBKDF2_ITERATIONS };
