// Shared fixture helper for the probes — pick a batch that FEFO will ACTUALLY use.
//
// TRAP #63/#64, hit again and worth a permanent fix rather than a fourth
// re-learning. Several probes chose a batch with `.find(x => x.quantity_remaining
// > 300 && ...)` and then priced their test sale at THAT batch's
// selling_price_per_unit. But the sale engine fills a line by FEFO — the
// nearest-expiry batch of that product — which is frequently a different batch
// at a different price. The sale is then refused with
//
//     Payments (150) do not sum to sale total (2713.2)
//
// which reads like a pricing bug in the application and is nothing of the kind:
// it is the probe doing arithmetic the app never agreed to. Measured on the
// current seed: the chosen batch was PDX-24A at N25 (expiry 2027-03-31) while
// FEFO fills from BETLZS at N452.20 (expiry 2026-08-21) — 20 "failures" in
// probe-credit alone, all of them mine.
//
// This got worse, not better, as the seed became more realistic: more branches
// and more deliveries mean more competing batches per product, so the odds that
// an arbitrarily-chosen batch is also the FEFO batch keep falling.
//
// The rule: NEVER choose a batch and assume it will be used. Choose a PRODUCT,
// resolve which batch FEFO will draw from, and price against that.

// Returns the batch the sale engine will actually consume for `productId`:
// the earliest-expiry batch with stock left. Mirrors salesService's FEFO
// ordering (nulls last, so a no-expiry batch is used only when nothing else
// remains).
function fefoBatchFor(stock, productId) {
  return stock
    .filter((s) => s.product_id === productId && s.quantity_remaining > 0)
    .sort((a, b) => String(a.expiry_date || '9999-12-31').localeCompare(String(b.expiry_date || '9999-12-31')))[0] || null;
}

// Picks a batch that is BOTH sellable and the FEFO batch for its own product,
// so `quantity * batch.selling_price_per_unit` is the price the server will
// compute. `predicate` filters candidates (e.g. excluding POM/controlled).
//
// Returns null rather than throwing: a probe should report "no usable fixture"
// as a finding, not die (trap #50).
function pickSellableFefoBatch(stock, { minQty = 1, predicate = () => true } = {}) {
  for (const candidate of stock) {
    if (!(candidate.quantity_remaining >= minQty)) continue;
    if (!(candidate.selling_price_per_unit > 0)) continue;
    if (!predicate(candidate)) continue;
    const fefo = fefoBatchFor(stock, candidate.product_id);
    // Only usable if the candidate IS what FEFO will pick, and that batch alone
    // can satisfy the quantity (a line split across two batches at different
    // prices is a legitimate app behaviour, but it makes the probe's expected
    // total ambiguous).
    if (fefo && fefo.id === candidate.id && fefo.quantity_remaining >= minQty) return fefo;
  }
  return null;
}

module.exports = { fefoBatchFor, pickSellableFefoBatch };
