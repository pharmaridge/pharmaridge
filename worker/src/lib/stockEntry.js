// Shared validation for anything that CREATES a stock batch.
//
// WHY THIS EXISTS (real patient-safety gap found during the pre-launch audit):
// stock_batches.expiry_date and batch_no are nullable in the schema, and the
// receiving routes accepted `b.expiry_date || null` without ever checking it.
// A batch admitted with no expiry date becomes permanently invisible to every
// safety control in the system at once:
//
//   * FEFO ordering (salesService loadStockPools) sorts NULL expiry LAST via
//     `CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END`, so it is dispensed
//     only after everything datable — it silently ages on the shelf.
//   * The expired-stock sale guard compares `batch.expiry_date != null && ...`,
//     so a NULL expiry can NEVER be blocked from sale, however old it is.
//   * v_expiry_alerts filters `WHERE sb.expiry_date IS NOT NULL`, so it is
//     never flagged for removal.
//   * Stocktake and valuation still count it, so the books look correct.
//
// The net effect is a batch of medicine that can be sold forever and will
// never appear on any expiry report. For a pharmacy this is a dispensing-
// safety and PCN-compliance failure, not a data-quality nit. Expiry is
// therefore mandatory at the point of entry.
//
// Deliberately NOT enforced with a NOT NULL column constraint: the schema is
// already deployed, historical rows may legitimately predate this rule, and a
// hard constraint would turn a recoverable 400 into an opaque D1 500. The rule
// belongs at the API boundary, where it can return an actionable message.

// Non-expiring shelf goods are a genuine case in a Nigerian pharmacy —
// glucometers, walking sticks, hot-water bottles, cotton wool. Those are
// admitted with an EXPLICIT `no_expiry: true` flag, so "this product does not
// expire" is a recorded decision rather than an empty field that might just be
// a rushed data-entry mistake.
const NO_EXPIRY_SENTINEL = null;

// Accepts YYYY-MM-DD (the HTML date input's native format).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Rejects 2026-02-31, which Date would silently roll into March.
  return d.toISOString().slice(0, 10) === s;
}

// West Africa Time is UTC+1 with no DST. Comparing an expiry against raw UTC
// "today" would mis-classify a batch for one hour each night — the same
// timezone bug the daily-sales views already correct for.
function watToday() {
  const now = new Date();
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Validates one incoming batch line. Returns an error STRING, or null if OK.
// `label` identifies the line in the message (a product id or name), because
// a receive request can carry many lines and "expiry is required" alone would
// not tell the storekeeper which row to fix.
function validateBatchEntry(b, label) {
  const who = label ? ` for ${label}` : '';

  // --- Expiry: the safety-critical field ---
  if (b.no_expiry === true) {
    // Explicitly declared non-expiring. Nothing further to check.
    if (b.expiry_date) {
      return `Batch${who} is marked as non-expiring but also has an expiry date. Choose one.`;
    }
  } else {
    const raw = b.expiry_date == null ? '' : String(b.expiry_date).trim();
    if (!raw) {
      return `Expiry date is required${who}. Every medicine batch must carry an expiry date — without one it can never be flagged as expired, never appear on the expiry report, and never be blocked from sale. If this item genuinely does not expire (e.g. a device or dressing), tick "This item does not expire" instead.`;
    }
    // Accept a full timestamp but store the date part.
    const datePart = raw.slice(0, 10);
    if (!isValidDateString(datePart)) {
      return `Expiry date${who} must be a real calendar date in YYYY-MM-DD format (got "${raw}").`;
    }
    const today = watToday();
    if (datePart < today) {
      return `Expiry date${who} is in the past (${datePart}). Expired stock must not be received into sellable inventory — quarantine it and raise a supplier return instead.`;
    }
    // A typo like 20226 would park stock 200 years out and defeat every
    // expiry alert just as effectively as a NULL.
    const maxYear = new Date().getUTCFullYear() + 30;
    if (Number(datePart.slice(0, 4)) > maxYear) {
      return `Expiry date${who} (${datePart}) is more than 30 years away — please check for a typing error.`;
    }
  }

  // --- Batch number: traceability ---
  // Required for a recall. NAFDAC recalls are issued by batch number; without
  // it a pharmacy cannot tell whether it holds affected stock, and the
  // controlled-drug register loses its audit link.
  if (b.no_expiry !== true) {
    const bn = b.batch_no == null ? '' : String(b.batch_no).trim();
    if (!bn) {
      return `Batch number is required${who}. A NAFDAC recall is issued by batch number — without it this stock cannot be traced or withdrawn.`;
    }
    if (bn.length > 64) {
      return `Batch number${who} is unusually long (${bn.length} characters) — please check it.`;
    }
  }

  return null;
}

// Normalises a validated line into the exact values to bind on INSERT.
function normaliseBatchEntry(b) {
  const noExpiry = b.no_expiry === true;
  return {
    batch_no: noExpiry
      ? (b.batch_no ? String(b.batch_no).trim() : null)
      : String(b.batch_no).trim(),
    expiry_date: noExpiry ? NO_EXPIRY_SENTINEL : String(b.expiry_date).trim().slice(0, 10),
  };
}

module.exports = { validateBatchEntry, normaliseBatchEntry, isValidDateString, watToday };
