// Shared HTTP request helpers.

// BUG 42 (live-reproduced on 14 of 14 mutating endpoints).
//
// Every route read its body as:
//
//     const body = await c.req.json().catch(() => ({}));
//
// The `.catch` handles a request whose body is not valid JSON. It does NOT
// handle a body that is valid JSON but is not an object. A request whose
// body is the four characters `null` parses SUCCESSFULLY to the value
// `null`, the catch never fires, and `body` becomes `null`. The very next
// line — `body.branch_id`, `body.amount`, whatever it is — throws
// "Cannot read properties of null", escapes as an unhandled exception, and
// the client gets a bare HTTP 500 "Internal server error".
//
// Verified against a live Worker by posting the literal body `null` to
// expenses, sales, adjustments, purchase-orders, transfers, customers,
// suppliers, products, branches, stocktakes, till/open, users, creditor
// payments and attendance/clock-in: ALL FOURTEEN returned 500.
//
// Why this matters beyond tidiness:
//   * A 500 is the one status the offline queue and the idempotency layer
//     treat as "transient, retry later" (see lib/idempotency.js and
//     public/js/offline.js). A permanently-malformed request therefore
//     retries forever instead of being rejected once.
//   * 500s are what a client's monitoring pages someone about at 2am. A
//     malformed request is the caller's fault and must read as 400.
//   * It is a free crash oracle for anyone probing the API.
//
// The same trap applies to any non-object JSON scalar — `null`, `true`,
// `42`, `"text"`, `[]` — so the guard normalises all of them, not just
// null. An array is rejected rather than coerced: no endpoint here accepts
// a top-level array, and silently turning `[]` into `{}` would hide a
// genuine client bug.
async function readJsonBody(c) {
  let parsed;
  try {
    parsed = await c.req.json();
  } catch (_) {
    // Malformed/absent JSON. Routes already treat {} as "nothing supplied"
    // and produce their own specific "x is required" 400s, which are far
    // more useful than a generic parse error.
    return {};
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed;
}

// BUG 77 — A SETTINGS WRITE THAT CHANGES NOTHING MUST NOT REPORT SUCCESS.
//
// Every config endpoint here reads a fixed list of known fields off the body
// and ignores everything else. That is safe (no mass-assignment) but it means
// a MISSPELLED field produced a clean 200 with the settings unchanged:
//
//     PUT /settings/vat {"vat_rate": 99}                  -> 200, VAT unchanged
//     PUT /settings/manager-permissions {"staff_can_void": false} -> 200, unchanged
//
// Both were live-reproduced. The real fields are `vat_rate_percent` and
// `staff_can_void_sales`. An owner who types the wrong name — or an integration
// written against a stale API doc — is told the change landed when it did not.
// On these particular endpoints that means believing VAT is set, or believing a
// cashier's ability to void sales has been revoked, when neither is true.
//
// This is the same class the codebase already closed on PUT /users/:id, where
// silently accepting `role` returned 200 with an unchanged record. The rule
// there and here: refuse explicitly, and name the fields that exist.
//
// Deliberately a SHARED helper rather than four copies: the next config
// endpoint added should inherit this behaviour without anyone remembering to.
function rejectUnknownFields(body, allowed, { label = 'this request' } = {}) {
  if (!body || typeof body !== 'object') return null;
  const known = new Set(allowed);
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length === 0) return null;
  return {
    error: `Unrecognised field${unknown.length > 1 ? 's' : ''} for ${label}: ${unknown.join(', ')}. `
      + `Nothing was changed. Valid fields are: ${[...known].sort().join(', ')}.`,
    code: 'UNKNOWN_FIELD',
    unknown_fields: unknown,
    valid_fields: [...known].sort(),
  };
}

// BUG 91 — A GUARD THAT READ `=== false` WHILE THE WRITE READ TRUTHINESS.
//
// Deactivation flags arrive over JSON in two equally valid shapes. The SPA's
// own Edit-User modal builds `is_active` from a <select> whose options are the
// strings "1"/"0" and compares `=== '1'`, so it sends a BOOLEAN; but the same
// column is an INTEGER, every read hands back 0/1, and any integration, curl
// call, retried offline payload or round-tripped record naturally sends the
// NUMBER 0. Both mean "switch this off", and the UPDATE itself accepted both,
// because it coerced: `vals.push(is_active ? 1 : 0)`.
//
// The guards did not. They asked `is_active === false`, so every one of them
// was skipped when the number 0 arrived, while the write went through anyway.
// Live-reproduced against a seeded five-branch estate:
//
//   PUT /users/:soleOwner {is_active: 0}   -> 200, zero active Owners left.
//        The same call with `false` is correctly refused (LAST_OWNER_PROTECTED).
//        No manager can undo it — PUT on an OWNER row is 403 for MANAGER — so
//        the pharmacy loses VAT, WHT and permission control until the VENDOR
//        intervenes. This is the exact lockout Bug 70 was raised to prevent.
//   PUT /users/:id {is_active: 0}          -> 200, open shift left open.
//        Bug 74's auto-close never fires, so the departing employee's shift
//        can never be closed by the normal path.
//   PUT /branches/:id {is_active: 0}       -> 200, closure_warning ABSENT.
//        Bug 86's "here is the work you left unfinished" notice vanishes;
//        a branch closed with an open till, an open shift, a pending PO and
//        an open stocktake reported a bare 200.
//
// So three previously-fixed bugs were all silently reachable again through a
// second doorway. The lesson is the general one: WHEN A WRITE COERCES, EVERY
// GUARD IN FRONT OF IT MUST COERCE IDENTICALLY. A stricter comparison on the
// guard than on the write is not "defensive"; it is a bypass.
//
// Hence one shared helper rather than four corrected comparisons, so the next
// boolean flag inherits the right behaviour instead of relying on memory.
// `undefined` (field absent) must stay distinct from an explicit false — a PUT
// that does not mention the field is not a deactivation — so this returns
// undefined rather than false when nothing was supplied.
const FALSEY_JSON = new Set([false, 0, '0', 'false', 'FALSE', 'False', 'no', 'off']);
const TRUTHY_JSON = new Set([true, 1, '1', 'true', 'TRUE', 'True', 'yes', 'on']);

function readBoolField(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (FALSEY_JSON.has(value)) return false;
  if (TRUTHY_JSON.has(value)) return true;
  // Anything else (an object, a stray string) is not a boolean. Treated as
  // "not supplied" so a nonsense value can never be read as an instruction.
  return undefined;
}

// True only when the caller explicitly asked to switch something OFF.
const isExplicitFalse = (value) => readBoolField(value) === false;

module.exports = { readJsonBody, rejectUnknownFields, readBoolField, isExplicitFalse };
