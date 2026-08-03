// BUG 112 — RECEIVING A DELIVERY THE WAY IT ACTUALLY ARRIVES.
//
// THE DEFECT THIS REPLACES. A sale could be rung up in CARTON, PACK or
// BASE_UNIT, but receiving accepted only base units. Worse, it accepted a
// `unit_type` field and SILENTLY IGNORED it: live-reproduced, a goods-received
// entry of `{ quantity_received: 10, unit_type: 'CARTON' }` for a product of
// 10 packs x 10 capsules recorded **10 capsules instead of 1,000** and
// returned 200. The storekeeper's stock file was short by 990 capsules with
// nothing to indicate anything had gone wrong.
//
// A supplier does not invoice in tablets. They deliver "10 cartons, 24 packs
// to a carton" and quote one price for the lot. Every previous version of this
// screen made a storekeeper do that arithmetic by hand at the delivery door,
// which is precisely where miscounts happen.
//
// THE MODEL (specified by the client):
//   * pick the unit the delivery arrived in — CARTON, PACK or PIECE;
//   * say how many of that unit;
//   * for CARTON, say how many packs are in a carton and how many pieces are
//     in a pack; for PACK, just how many pieces are in a pack;
//   * enter the TOTAL PRICE PAID for the whole delivery line, and let the
//     system derive the per-carton, per-pack and per-piece cost;
//   * choose the selling pattern — how this product is sold over the counter.
//
// Everything below is pure arithmetic with no I/O, so the same functions run
// on the server (authority) and in the browser (live preview) and cannot
// disagree. That shared-source discipline is deliberate: a preview that
// computes 1,000 while the server stores 10 is the bug this file exists to
// end.

const RECEIVE_UNITS = ['CARTON', 'PACK', 'PIECE'];
const SELLING_PATTERNS = ['CARTON', 'PACK', 'PIECE'];

// Upper bounds are typo guards in the same spirit as MAX_QUANTITY (Bug 104):
// a carton holds tens or hundreds of pieces, never millions, and a nesting
// figure is multiplied by the quantity before it reaches the ledger.
const MAX_PACKS_PER_CARTON = 10000;
const MAX_UNITS_PER_PACK = 10000;

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0;
}

// How many base units (pieces) one unit of `unit` contains.
function piecesPerUnit(unit, { unitsPerPack = 1, packsPerCarton = 1 } = {}) {
  if (unit === 'PIECE') return 1;
  if (unit === 'PACK') return unitsPerPack;
  if (unit === 'CARTON') return unitsPerPack * packsPerCarton;
  return null;
}

// Validates a receive line expressed in supplier units and converts it to the
// base units the stock ledger actually stores.
//
// Returns { ok: true, ... } or { ok: false, error, code } — never throws, so
// the caller decides the HTTP shape. The browser uses the same return to drive
// its live "10 cartons = 1,000 capsules" preview.
function resolveReceiveLine(line, { label = 'this line' } = {}) {
  const unit = line.receive_unit || 'PIECE';
  if (!RECEIVE_UNITS.includes(unit)) {
    return { ok: false, code: 'RECEIVE_UNIT_INVALID',
      error: `${label}: choose how the delivery arrived — ${RECEIVE_UNITS.join(', ')}.` };
  }

  const count = line.receive_quantity;
  if (!isPositiveInt(count)) {
    return { ok: false, code: 'RECEIVE_QUANTITY_INVALID',
      error: `${label}: say how many ${unit.toLowerCase()}s arrived — a whole number, at least 1.` };
  }

  // Nesting is only required for the units that actually nest. Asking for
  // "pieces per pack" when the delivery IS pieces is a question with no
  // meaning, and a form that asks it teaches the user to type anything.
  let unitsPerPack = 1;
  let packsPerCarton = 1;

  if (unit === 'PACK' || unit === 'CARTON') {
    unitsPerPack = line.units_per_pack;
    if (!isPositiveInt(unitsPerPack)) {
      return { ok: false, code: 'UNITS_PER_PACK_REQUIRED',
        error: `${label}: say how many pieces are in one pack.` };
    }
    if (unitsPerPack > MAX_UNITS_PER_PACK) {
      return { ok: false, code: 'UNITS_PER_PACK_IMPLAUSIBLE',
        error: `${label}: ${unitsPerPack.toLocaleString('en-NG')} pieces in a pack looks like a mistake. Check for an extra digit.` };
    }
  }

  if (unit === 'CARTON') {
    packsPerCarton = line.packs_per_carton;
    if (!isPositiveInt(packsPerCarton)) {
      return { ok: false, code: 'PACKS_PER_CARTON_REQUIRED',
        error: `${label}: say how many packs are in one carton.` };
    }
    if (packsPerCarton > MAX_PACKS_PER_CARTON) {
      return { ok: false, code: 'PACKS_PER_CARTON_IMPLAUSIBLE',
        error: `${label}: ${packsPerCarton.toLocaleString('en-NG')} packs in a carton looks like a mistake. Check for an extra digit.` };
    }
  }

  const per = piecesPerUnit(unit, { unitsPerPack, packsPerCarton });
  const totalPieces = count * per;

  // The selling pattern is how the counter will sell it, and it is NOT
  // required to match how it arrived: a pharmacy routinely buys by the carton
  // and sells by the tablet — that is the entire business. It must, however,
  // be a unit the delivery can actually be broken into.
  const pattern = line.selling_pattern || 'PIECE';
  if (!SELLING_PATTERNS.includes(pattern)) {
    return { ok: false, code: 'SELLING_PATTERN_INVALID',
      error: `${label}: choose how this product is sold — ${SELLING_PATTERNS.join(', ')}.` };
  }
  if (pattern === 'CARTON' && unit !== 'CARTON') {
    return { ok: false, code: 'SELLING_PATTERN_UNREACHABLE',
      error: `${label}: you cannot sell by the carton when the delivery was not received in cartons — the system would not know how many pieces a carton holds.` };
  }
  if (pattern === 'PACK' && unit === 'PIECE') {
    return { ok: false, code: 'SELLING_PATTERN_UNREACHABLE',
      error: `${label}: you cannot sell by the pack when the delivery was received as loose pieces — say how many pieces make a pack first.` };
  }

  return {
    ok: true,
    unit,
    count,
    unitsPerPack,
    packsPerCarton,
    piecesPerReceiveUnit: per,
    totalPieces,
    sellingPattern: pattern,
  };
}

// Splits ONE total price for the whole delivery line into per-carton,
// per-pack and per-piece cost.
//
// WHY TOTAL-FIRST RATHER THAN UNIT-FIRST. The supplier's invoice states a
// total; the per-tablet cost is a number nobody writes down. Asking the
// storekeeper to divide N480,000 by 1,000 capsules and type 480 is asking them
// to do the system's job, and a slip of a decimal place there silently
// corrupts every margin the product reports afterwards.
//
// The per-piece figure is deliberately NOT rounded to kobo. Rounding
// 480,000/7,000 to 68.57 and multiplying back gives 479,990 — the stock would
// be valued N10 below what was actually paid, on every delivery, forever.
// Full precision is kept for valuation; the DISPLAY rounds.
function splitTotalCost(totalCost, resolved) {
  if (!Number.isFinite(totalCost) || totalCost < 0) {
    return { ok: false, code: 'TOTAL_COST_INVALID',
      error: 'Enter the total amount paid for this line — the figure on the supplier invoice.' };
  }
  const { totalPieces, unitsPerPack, packsPerCarton, unit } = resolved;
  const perPiece = totalPieces > 0 ? totalCost / totalPieces : 0;
  return {
    ok: true,
    totalCost,
    costPerPiece: perPiece,
    costPerPack: unit === 'PIECE' ? null : perPiece * unitsPerPack,
    costPerCarton: unit === 'CARTON' ? perPiece * unitsPerPack * packsPerCarton : null,
  };
}

// One human-readable sentence for the receive screen and the goods-received
// note, e.g. "10 cartons x 10 packs x 10 pieces = 1,000 pieces".
function describeReceipt(resolved) {
  const n = (x) => Number(x).toLocaleString('en-NG');
  const { unit, count, unitsPerPack, packsPerCarton, totalPieces } = resolved;
  if (unit === 'PIECE') return `${n(count)} piece${count === 1 ? '' : 's'}`;
  if (unit === 'PACK') {
    return `${n(count)} pack${count === 1 ? '' : 's'} x ${n(unitsPerPack)} pieces = ${n(totalPieces)} pieces`;
  }
  return `${n(count)} carton${count === 1 ? '' : 's'} x ${n(packsPerCarton)} packs x ${n(unitsPerPack)} pieces = ${n(totalPieces)} pieces`;
}

module.exports = {
  RECEIVE_UNITS, SELLING_PATTERNS,
  MAX_PACKS_PER_CARTON, MAX_UNITS_PER_PACK,
  piecesPerUnit, resolveReceiveLine, splitTotalCost, describeReceipt,
};
