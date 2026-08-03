// WHERE THE MONEY CAME FROM — the drawer, the safe, or both.
//
// THE PROBLEM. A branch pays for things out of two pots of physical cash: the
// counter drawer and the shop safe. Until now a payment had to name exactly
// one. That is wrong twice over:
//
//   * A cashier sent to buy a carton the drawer cannot cover had to find a
//     manager first — the safe was manager-only — so the shop stopped.
//   * A real purchase is often funded from BOTH: "there was N8,000 in the
//     drawer, I took the other N12,000 from the safe". Forcing one method made
//     the operator lie about one of the two, and the lie lands in the accounts:
//     either the drawer reconciles short or the safe does.
//
// Live-reproduced before this existed: posting an expense with a `payments`
// array split across CASH and SAFE returned **201** and booked the ENTIRE
// amount to CASH. The split was silently discarded — the Bug 77 class, a
// success response for something that did not happen.
//
// THE MODEL. A payment may carry `cash_sources: [{ source, amount }, ...]`
// where source is 'CASH' (the drawer) or 'SAFE' (the reserve). A single
// `paid_by_method` still works and is unchanged; the array is the general
// case, and one source is just an array of length one.
//
// Each pot is then checked on its OWN terms, because they are different
// things with different rules:
//   drawer  must physically hold it (Bug 96) — a cash box cannot go negative
//   safe    must physically hold it, AND the person must be allowed to spend
//           from it (manager always; staff only within the owner-set allowance)
const { round2 } = require('./business');
const { getClientSettings } = require('./planLimits');

const CASH_SOURCES = ['CASH', 'SAFE'];

// Reads the staff safe allowance, defaulting when the columns are absent (an
// older database) so behaviour never silently tightens on upgrade — the same
// rule staffSetting() already applies to the void and write-off allowances.
function staffSafeAllowance(settings) {
  const enabled = settings.staff_can_spend_from_safe;
  const cap = settings.staff_safe_spend_max;
  return {
    enabled: enabled === undefined || enabled === null ? true : !!enabled,
    // 0 means NO CAP, deliberately — the client asked to be able to set "no
    // limit". It is never read as "zero allowed": whether a cashier may spend
    // at all is the boolean, not this number.
    cap: cap === undefined || cap === null ? 20000 : Number(cap),
  };
}

// Normalises whatever the caller sent into a list of {source, amount} that
// sums to `total`. Accepts three shapes so existing callers keep working:
//
//   cash_sources: [{source:'CASH',amount:8000},{source:'SAFE',amount:12000}]
//   paid_by_method: 'SAFE'      -> [{source:'SAFE', amount: total}]
//   paid_by_method: 'TRANSFER'  -> [] (nothing left either pot of cash)
//
// Returns { sources, error }. `sources` is [] for non-cash methods.
function resolveCashSources(body, total) {
  const grand = round2(Number(total));
  const raw = body.cash_sources;

  if (raw === undefined || raw === null) {
    const method = body.paid_by_method || 'CASH';
    if (!CASH_SOURCES.includes(method)) return { sources: [] };  // TRANSFER / POS_CARD
    return { sources: [{ source: method, amount: grand }] };
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: {
      error: 'cash_sources must be a list saying where the money came from, e.g. '
        + '[{"source":"CASH","amount":8000},{"source":"SAFE","amount":12000}].',
      code: 'INVALID_CASH_SOURCES', status: 400,
    } };
  }
  if (raw.length > CASH_SOURCES.length) {
    return { error: {
      error: 'There are only two pots of cash at a branch: the till drawer and the safe.',
      code: 'INVALID_CASH_SOURCES', status: 400,
    } };
  }

  const seen = new Set();
  const sources = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { error: { error: 'Each cash source must be an object with a source and an amount.', code: 'INVALID_CASH_SOURCES', status: 400 } };
    }
    const source = String(entry.source || '').toUpperCase();
    if (!CASH_SOURCES.includes(source)) {
      return { error: {
        error: `Each cash source must be one of: ${CASH_SOURCES.join(', ')}. `
          + 'Money from the bank is a TRANSFER and does not come from either pot.',
        code: 'INVALID_CASH_SOURCES', status: 400,
      } };
    }
    // A repeated pot is almost always a mistake, and summing it silently would
    // hide which figure the operator meant.
    if (seen.has(source)) {
      return { error: { error: `${source} appears twice — give one line per pot.`, code: 'DUPLICATE_CASH_SOURCE', status: 400 } };
    }
    seen.add(source);
    const amount = round2(Number(entry.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return { error: { error: `The amount taken from the ${source === 'CASH' ? 'drawer' : 'safe'} must be greater than zero.`, code: 'INVALID_CASH_SOURCES', status: 400 } };
    }
    sources.push({ source, amount });
  }

  // The split MUST account for the whole payment. A split that does not add up
  // is the one failure mode that would quietly corrupt both pots at once, so it
  // is refused rather than apportioned.
  const summed = round2(sources.reduce((s, x) => s + x.amount, 0));
  if (Math.abs(summed - grand) > 0.005) {
    return { error: {
      error: `The amounts taken from the drawer and the safe come to N${summed.toFixed(2)}, `
        + `but the payment is N${grand.toFixed(2)}. They must match exactly.`,
      code: 'CASH_SOURCES_DO_NOT_SUM', status: 400,
      sources_total: summed, payment_total: grand,
    } };
  }
  return { sources };
}

// May this person take THIS much from the safe?
//
// Managers and owners: always (subject to their branch scope, checked by
// branchSafeService.assertCanMoveSafe). Staff: only within the allowance the
// owner or a manager set.
async function assertStaffSafeSpend(db, user, amount) {
  if (!user || user.role !== 'STAFF') return null;
  const settings = await getClientSettings(db);
  const { enabled, cap } = staffSafeAllowance(settings);

  if (!enabled) {
    return {
      error: 'Taking money from the safe needs a manager. Ask a manager to record this purchase, '
        + 'or pay from the till drawer.',
      code: 'STAFF_SAFE_REQUIRES_MANAGER', status: 403,
    };
  }
  // cap === 0 means NO CAP. See the schema comment: the can/cannot decision is
  // the boolean above, so zero here is "unlimited", not "nothing".
  if (cap > 0 && round2(Number(amount)) > cap + 0.005) {
    return {
      error: `You can take up to N${cap.toFixed(2)} from the safe for one purchase `
        + `(this one needs N${round2(Number(amount)).toFixed(2)}). Ask a manager to record it.`,
      code: 'STAFF_SAFE_OVER_CAP', status: 403,
      allowance: cap, requested: round2(Number(amount)),
    };
  }
  return null;
}

module.exports = { CASH_SOURCES, resolveCashSources, assertStaffSafeSpend, staffSafeAllowance };
