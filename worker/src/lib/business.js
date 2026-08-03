// Pure math/business-rule helpers with zero platform dependencies — safe
// to run identically in the Node/Express deployment and here in Cloudflare
// Workers. Logic mirrors the original implementation*.js in the original
// design exactly; keep the two in sync if either changes.

const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two lat/lng points, in meters.
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

// Classifies a device-reported position against a branch's geofence.
function classifyLocation(branch, lat, lng) {
  if (lat == null || lng == null) {
    return { status: 'NO_LOCATION', distanceMeters: null };
  }
  if (branch.latitude == null || branch.longitude == null) {
    return { status: 'GEOFENCE_NOT_SET', distanceMeters: null };
  }
  const distanceMeters = haversineDistanceMeters(branch.latitude, branch.longitude, lat, lng);
  const status = distanceMeters <= branch.geofence_radius_meters ? 'ON_SITE' : 'OFF_SITE';
  return { status, distanceMeters };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// BUG 41. Every money endpoint validated `amount > 0` and then handed the
// value to the GL, which rounds to 2dp (kobo) before posting. Any amount
// below half a kobo — 0.001, 0.004 — passes `> 0`, rounds to 0.00, and the
// GL's own correct guard ("a journal line must have a debit or a credit")
// throws deep inside the posting. Reproduced live on FOUR paths: expenses
// and supplier payments returned a raw HTTP 500 "Internal server error";
// customer repayments the same; a sale leaked the internal wording
// "GL posting error: journal line for account SALES_REVENUE has neither a
// debit nor a credit" straight to the cashier's screen.
//
// Naira has no sub-kobo denomination, so a 0.004 expense is meaningless as
// money — it is a typo or a hostile probe. The right answer is a clean 400
// at the edge naming the smallest real amount, not a 500 from the ledger.
// A shared floor is used rather than four copies so a fifth money endpoint
// cannot reintroduce the gap.
const MIN_MONEY = 0.01; // one kobo — the smallest amount Naira can express

// BUG 103 — THERE WAS A FLOOR BUT NO CEILING.
//
// Every money guard in this codebase was written against sensible figures, so
// nobody had asked what a hostile or fat-fingered number does. A deposit of
// 1e15 was accepted, and the branch safe then reported a balance of
// N1,000,000,000,152,074.4 — a figure that is not merely absurd but has
// already lost precision: adding one kobo to it is a no-op, because 1e15 naira
// is 1e17 kobo and JavaScript can only hold integers exactly up to
// ~9.007e15. Past that point money silently stops adding up.
//
// Two separate reasons for a cap, and the business one binds first:
//
//   PRECISION   above ~9.0e13 naira, kobo arithmetic starts losing digits.
//   REALITY     Nigeria's ENTIRE pharmaceutical market is on the order of
//               N1.5 trillion a year. A single expense, safe movement or
//               payment above N10 billion is a mis-keyed amount, never a
//               transaction — and catching it at entry is far kinder than
//               letting it into the ledger and reconciling it out later.
//
// N10,000,000,000 is therefore about 6,600x the largest single transaction a
// real pharmacy will ever record, and roughly 9,000x below where the
// arithmetic degrades — comfortably clear of both.
const MAX_MONEY = 10000000000; // N10 billion — a typo guard, not a policy

// Returns null when valid, else a human-readable reason. `label` names the
// field for the person reading the error, not the API client.
function validateMoneyAmount(value, label = 'amount') {
  if (!Number.isFinite(value)) return `${label} must be a number`;
  if (value <= 0) return `${label} must be a positive number`;
  if (round2(value) < MIN_MONEY) {
    return `${label} must be at least N${MIN_MONEY.toFixed(2)} (one kobo). N${value} rounds to zero.`;
  }
  if (value > MAX_MONEY) {
    return `${label} of N${value.toLocaleString('en-NG')} looks like a mistake — the most a single `
      + `entry may be is N${MAX_MONEY.toLocaleString('en-NG')}. Check for an extra digit.`;
  }
  return null;
}

// TEXT FIELDS HAD NO UPPER BOUND EITHER (same bug, different column).
//
// A 200,000-character reason was accepted and stored verbatim on a safe
// movement. D1 has a 500 MB database ceiling this deployment already tracks
// and warns on, so unbounded free text is a real capacity risk as well as a
// rendering one — that string is then loaded into every list that shows the
// movement, on a phone, over a Nigerian mobile connection.
//
// The limits are generous: nobody legitimately types 2,000 characters into a
// reason box, but a manager pasting a paragraph of context must not be
// refused.
const MAX_TEXT = { reason: 2000, notes: 2000, description: 2000, name: 200 };

// BUG 104 — MONEY WAS CAPPED; QUANTITY WAS NOT.
//
// Bug 103 put a ceiling on every AMOUNT and the class was declared closed. It
// was not: money is not the only number that reaches the ledger. A purchase
// order carries a QUANTITY, and the GL posts quantity x unit_cost — so an
// unbounded quantity multiplied by a perfectly legal unit cost produces
// exactly the oversized figure MAX_MONEY exists to prevent, by the back door.
//
// Live-reproduced before this fix: a PO for 1e15 units at a legal N100 each
// was accepted (Number.isInteger(1e15) is true and nothing else looked), the
// goods-received posted, and **the trial balance came out N4 short** —
// INVENTORY_ASSET debited 100000000000000000 against CASH credited
// 100000000000000100. The books, which balance to the kobo through every
// other path in this system, silently stopped balancing. Nothing errored.
//
// WHY 100,000,000 (one hundred million units):
//   PRECISION  the ledger multiplies qty x cost and then works in kobo, so
//              the product must stay a safe integer when multiplied by 100.
//              At this cap even an implausible N12,500/unit stays exact.
//   REALITY    the largest pharmaceutical wholesale cartons in Nigeria run to
//              a few tens of thousands of base units. One hundred million is
//              already thousands of times any real delivery, so it can only
//              ever catch a typo — never a genuine order.
//
// Deliberately NOT set to MAX_SAFE_INTEGER: a cap that only prevents the
// arithmetic from breaking still lets a mis-keyed 9-quadrillion-unit delivery
// into a client's stock file, which is a data-integrity problem even when
// every number adds up.
const MAX_QUANTITY = 100000000;

// Returns null when valid, else a human-readable reason.
//
// Whole-number enforcement lives here too, because it is the same question
// asked at the same boundary: `Number.isInteger` was already being re-typed
// at each call site (Bug 82 fixed it in two places and missed the rest), and
// a shared validator is the only way a NEW quantity endpoint inherits the
// rule instead of re-earning the bug.
function validateQuantity(value, label = 'quantity', { allowZero = false } = {}) {
  if (!Number.isFinite(value)) return `${label} must be a number`;
  if (!Number.isInteger(value)) {
    return `${label} must be a whole number of units — you cannot count part of a tablet or bottle.`;
  }
  if (allowZero ? value < 0 : value <= 0) {
    return `${label} must be ${allowZero ? 'zero or more' : 'a positive number'}`;
  }
  if (value > MAX_QUANTITY) {
    return `${label} of ${value.toLocaleString('en-NG')} units looks like a mistake — the most a `
      + `single entry may be is ${MAX_QUANTITY.toLocaleString('en-NG')}. Check for an extra digit.`;
  }
  return null;
}

function validateTextLength(value, label = 'text', max = 2000) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (str.length > max) {
    return `${label} is too long (${str.length.toLocaleString('en-NG')} characters). `
      + `Please keep it under ${max.toLocaleString('en-NG')}.`;
  }
  return null;
}

// BUG 113 — A PACK MUST MEAN THE SAME NUMBER OF PIECES TO THE PRICE AND TO
// THE SHELF.
//
// This took the pack size from the PRODUCT record. Bug 112 then began storing
// the nesting AS DELIVERED on each batch, because suppliers genuinely differ
// — the same syrup arrives 10-to-a-pack from one and 24 from another. Pricing
// already read the BATCH (unitPriceFor), so the two halves of one sale started
// answering to different authorities.
//
// Live-reproduced: a batch delivered as packs of 24, on a product whose
// default is 10. Selling "1 pack" charged the batch's N4,800 pack price and
// removed **10 bottles**. The customer paid for 24 and carried away 10, and
// the stock file agreed with neither the invoice nor the shelf.
//
// `batch` is now consulted FIRST and the product is the fallback for stock
// that predates Bug 112 (those rows have NULL nesting, which is correct — they
// really were received at the product default). Passing no batch keeps the old
// behaviour for callers that legitimately have no batch in hand, e.g. an
// order-time estimate before FEFO has chosen one.
function packSizeFor(product, batch) {
  const b = batch || {};
  return {
    unitsPerPack: b.units_per_pack_at_receipt || product.units_per_pack || 1,
    packsPerCarton: b.packs_per_carton_at_receipt || product.packs_per_carton || 1,
  };
}

function baseUnitsFor(product, unitType, quantity, batch) {
  if (unitType === 'BASE_UNIT') return quantity;
  const { unitsPerPack, packsPerCarton } = packSizeFor(product, batch);
  if (unitType === 'PACK') return quantity * unitsPerPack;
  if (unitType === 'CARTON') return quantity * packsPerCarton * unitsPerPack;
  throw new Error(`Unknown unit_type: ${unitType}`);
}

function unitPriceFor(batch, unitType) {
  if (unitType === 'BASE_UNIT') return batch.selling_price_per_unit;
  if (unitType === 'PACK') return batch.pack_price != null ? batch.pack_price : null;
  if (unitType === 'CARTON') return batch.carton_price != null ? batch.carton_price : null;
  return null;
}

// BUG 52. Money is stored in SQLite REAL columns. That is a deliberate,
// documented trade-off (SQLite has no DECIMAL; the alternative is INTEGER
// kobo), and it is SAFE ONLY WHILE EVERY STORED VALUE IS ALREADY ROUNDED
// TO TWO DECIMALS — which is what makes accumulation exact: summing values
// that are each an exact multiple of 0.01 stays exact far beyond any
// pharmacy's lifetime turnover (measured: 73,000 sales at awkward prices
// summed with ZERO drift; doubles hold kobo-exact integers to ~N90 trillion).
//
// The guarantee held everywhere the code computed a figure — salesService,
// glService and tillService all wrap writes in round2(). It did NOT hold
// where a value came straight from the CLIENT: expenses.amount, supplier
// and customer payments, and product price overrides were bound verbatim.
//
// Live-reproduced: an expense of 1000.005999 stored as 1000.005999 while
// its own GL entry (correctly rounded) posted 1000.01 — the expense list
// and the P&L then disagree by four-tenths of a kobo, on the same
// transaction, with no way for a client to reconcile them. Repeat that
// across a year and the "unexplained difference" is real even though no
// single figure looks wrong.
//
// normaliseMoney is the boundary: any amount entering the system from a
// request body is snapped to kobo BEFORE it is stored, so the REAL columns
// only ever contain values the format can represent exactly.
function normaliseMoney(value) {
  return Number.isFinite(value) ? round2(value) : value;
}

module.exports = { haversineDistanceMeters, classifyLocation, round2, baseUnitsFor, packSizeFor, unitPriceFor, validateMoneyAmount, validateTextLength, validateQuantity, normaliseMoney, MIN_MONEY, MAX_MONEY, MAX_TEXT, MAX_QUANTITY };
