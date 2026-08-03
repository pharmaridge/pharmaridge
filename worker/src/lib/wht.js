// WITHHOLDING TAX (WHT) — Deduction of Tax at Source.
//
// WHT is not another tax. It is an ADVANCE PAYMENT of income tax that the
// PAYER deducts at source and remits to the revenue authority on the
// payee's behalf. Two directions exist and must never be conflated:
//
//   PAYABLE     the pharmacy deducts from what it pays out  -> LIABILITY
//   RECEIVABLE  a customer deducts from what it pays in     -> ASSET
//
// THE ONE INVARIANT, in both directions:
//
//     gross = net_paid + wht_amount
//
// The GROSS figure is what hits the expense (or revenue) account. Only the
// CASH leg is reduced. Getting this backwards understates expenses or
// revenue and produces a P&L that disagrees with the underlying invoices.
// This module is the single place that arithmetic lives; every route and
// the GL service go through it so the rule cannot drift between callers.
//
// Rates are DATA, not code — see migrations/0001 for why (Nigerian rates
// changed materially under the Deduction of Tax at Source (Withholding)
// Regulations 2024, effective 1 January 2025). Nothing here hardcodes a
// percentage; callers resolve a rate row and pass the percentage in.

// Money rounding: identical to glService.round2 so a figure computed here
// and a figure computed there can never disagree by a hair.
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// The small-company exemption in the 2024 Regulations: a small company or
// unincorporated body need not deduct WHT where the transaction value in
// the relevant CALENDAR MONTH is not above ₦2,000,000 and the supplier
// holds a valid TIN.
//
// This is ADVISORY ONLY (client decision: warn, never block). Whether a
// given pharmacy is itself a "small company" depends on its own turnover,
// which this system does not authoritatively know, and the ₦2m test is
// per-supplier-per-month rather than per-transaction. So the app surfaces
// the hint and lets the owner — who does know — decide.
const SMALL_COMPANY_MONTHLY_THRESHOLD = 2000000;

// Compute a deduction from a GROSS amount.
//
// Deliberately takes gross, never net. A pharmacy always knows the invoice
// value; asking it to supply the net would mean grossing up, which is
// exactly the "WHT as an additional contract cost" practice the 2024
// Regulations explicitly prohibit.
function computeWht({ grossAmount, ratePercent }) {
  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    throw Object.assign(new Error('WHT gross amount must be a non-negative number'), { status: 400, code: 'WHT_INVALID_GROSS' });
  }
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'), { status: 400, code: 'WHT_INVALID_RATE' });
  }
  const gross = round2(grossAmount);
  const wht = round2((gross * ratePercent) / 100);
  // Derive net by SUBTRACTION, never by a second independent rounding.
  // Rounding both legs separately is the classic way gross = net + wht
  // fails by a kobo, which the database CHECK would then reject outright.
  const net = round2(gross - wht);
  return { gross, wht, net, ratePercent };
}

// Look up an active rate by code. Returns null rather than throwing so a
// caller can distinguish "no WHT requested" from "bad code".
async function findRate(db, code) {
  if (!code) return null;
  return db.prepare(
    'SELECT * FROM wht_rates WHERE code = ? AND is_active = 1 AND is_deleted = 0'
  ).bind(String(code).trim().toUpperCase()).first();
}

// Resolve what a caller asked for into a validated deduction, or null when
// no WHT applies. Centralised so every route rejects the same bad input in
// the same way with the same error codes.
//
// `direction` is checked against the rate's own direction: a RECEIVABLE-only
// rate must not be usable on an expense, and vice versa.
async function resolveDeduction(db, { grossAmount, rateCode, ratePercentOverride, direction }) {
  if (!rateCode && ratePercentOverride == null) return null;

  let ratePercent;
  let resolvedCode = rateCode ? String(rateCode).trim().toUpperCase() : 'CUSTOM';

  if (rateCode) {
    const row = await findRate(db, rateCode);
    if (!row) {
      throw Object.assign(
        new Error(`Unknown or inactive WHT rate "${rateCode}". Choose a rate from Settings → Withholding Tax, or add it there first.`),
        { status: 400, code: 'WHT_UNKNOWN_RATE' }
      );
    }
    if (row.direction !== 'BOTH' && row.direction !== direction) {
      throw Object.assign(
        new Error(`WHT rate "${row.code}" applies to ${row.direction} transactions only and cannot be used on a ${direction} one.`),
        { status: 400, code: 'WHT_WRONG_DIRECTION' }
      );
    }
    ratePercent = row.rate_percent;
    resolvedCode = row.code;
  }

  // An explicit override wins, so a one-off non-resident rate or a tax
  // adviser's instruction does not require editing the shared schedule.
  if (ratePercentOverride != null) {
    if (!Number.isFinite(ratePercentOverride) || ratePercentOverride < 0 || ratePercentOverride > 100) {
      throw Object.assign(new Error('WHT rate must be a percentage between 0 and 100'), { status: 400, code: 'WHT_INVALID_RATE' });
    }
    ratePercent = ratePercentOverride;
  }

  const computed = computeWht({ grossAmount, ratePercent });
  if (computed.wht <= 0) return null; // a 0% rate is not a deduction

  // A deduction can never exceed the payment it is taken from.
  if (computed.wht > computed.gross) {
    throw Object.assign(new Error('WHT cannot exceed the gross amount'), { status: 400, code: 'WHT_EXCEEDS_GROSS' });
  }

  return { ...computed, rateCode: resolvedCode };
}

// Advisory exemption hint. Returns a message or null; NEVER blocks.
function exemptionHint({ grossAmount, counterpartyTin }) {
  if (!Number.isFinite(grossAmount)) return null;
  if (grossAmount > SMALL_COMPANY_MONTHLY_THRESHOLD) return null;
  if (!counterpartyTin) {
    return 'Under the 2024 Regulations a small company need not deduct WHT on a transaction of N2,000,000 or less in a calendar month WHERE THE SUPPLIER HAS A VALID TIN. No TIN was recorded here, so the exemption cannot be relied on.';
  }
  return 'This transaction is N2,000,000 or less and the supplier has a TIN — if your pharmacy qualifies as a small company under the 2024 Regulations, you may not be required to deduct WHT at all. Check with your tax adviser; PharmaRidge does not decide this for you.';
}

// Builds the INSERT for the audit/credit-note row. Returned as a statement
// for the caller to append to its own db.batch(), so the WHT record, the
// source row and the GL posting all commit atomically together — the same
// discipline glService already follows.
function buildEntryStatement(db, {
  id, branchId, direction, sourceType, sourceId, deduction,
  supplierId, customerId, counterpartyName, counterpartyTin,
  certificateNo, recordedBy, notes,
}) {
  return db.prepare(`
    INSERT INTO wht_entries (
      id, branch_id, direction, source_type, source_id, rate_code, rate_percent,
      gross_amount, wht_amount, net_amount, supplier_id, customer_id,
      counterparty_name, counterparty_tin, certificate_no, recorded_by, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    id, branchId, direction, sourceType, sourceId, deduction.rateCode, deduction.ratePercent,
    deduction.gross, deduction.wht, deduction.net, supplierId || null, customerId || null,
    counterpartyName || null, counterpartyTin || null, certificateNo || null, recordedBy, notes || null
  );
}

module.exports = {
  round2,
  computeWht,
  findRate,
  resolveDeduction,
  exemptionHint,
  buildEntryStatement,
  SMALL_COMPANY_MONTHLY_THRESHOLD,
};
