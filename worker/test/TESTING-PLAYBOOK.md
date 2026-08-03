# Browser probes (`test/tools/`)

These are **not** part of `npm test`. They need a real Chromium and a running
dev server, neither of which the offline suites require, so they are run
deliberately rather than on every commit.

They exist because a whole class of defect in this app is invisible to any
test that reads source code:

| Bug | How it was found | Why source review missed it |
|---|---|---|
| 56 | rendered with no emoji font | the emoji was *there*, it just didn't draw |
| 57 | scrim measured after a hash change | two files each looked correct alone |
| 58 | `scrollWidth` at 320-414px | no rule said "overflow"; it emerged from flex defaults |
| 59 | `hasSvg:false` after login | one file undid another file's fix at runtime |
| 61 | measured every control at 8 widths | a 13x13 checkbox looks fine in a screenshot |
| 62 | same sweep, 152 instances | 28px "looks" tappable until you measure it |
| 63 | slowed one endpoint to 2.5s | needs a race; instant localhost never shows it |
| 65 | coverage sweep of every `.batch(` site | the wrapper existed; six sites just never used it |
| 66 | read the real response headers | `_headers` looks like it covers everything — it covers Pages only |
| 67 | broke IndexedDB and read the toast | the behaviour was right; only the WORDING was unusable |
| 68 | aged a key 20 days, ran the real cron | needs two retention windows to disagree over weeks |
| 69 | signed in as ADMIN and opened #/plan | backend said yes, frontend said no — neither file is wrong alone |
| 70 | counted OWNERS, not "admin seats" | the guard looked right; it counted the wrong set |
| 71 | clocked a manager in with no GPS, then overrode it | the report CLAIMED this was blocked; nobody had run it |
| 72 | read /api/suppliers with a cashier token | the nav item was hidden, so nobody checked the endpoint |
| 73 | FOLLOWED the app's own error message | every role was audited alone; nobody walked a transition BETWEEN them |

## Running them

```bash
# 1. one clean server (also resets + seeds the local D1)
bash test/devserver.sh 9001

# 2. the probe
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-theme.js   # 105 checks
```

`probe-theme.js` measures **rendered** behaviour: computed colours run through
a real WCAG contrast calculation in both themes, the theme attribute captured
at the exact moment `<body>` is inserted (the no-flash contract), the mobile
drawer/scrim, and horizontal overflow at 320/360/390/414px.

`probe-responsive.js` (1202 checks) drives all 19 screens at 8 widths as three
different roles and measures overflow, escaped elements, WCAG 2.2 target size,
clipped text and table scroll containment. It also asserts its own screen list
matches the shipped nav both ways, so a new screen cannot skip the audit.

```bash
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-responsive.js  # ~6 min
```

`shots.js` writes `~/shot-{light,dark}-*.png` for eyeball review.

## Two traps that already cost real time here — do not repeat

1. **The service worker will serve you a stale stylesheet.** A CSS assertion
   made without `page.setCacheEnabled(false)` *and* unregistering the SW and
   clearing `caches` is meaningless: a deliberately reverted fix still
   "passed" because the browser was rendering the previous build.
2. **Trusted input stops working after login in this headless setup.**
   `document.hasFocus()` goes false and `page.click`, `page.mouse.click` and
   raw `Input.dispatchMouseEvent` all get discarded, while `el.click()` works.
   This reproduces identically against commits made before any of this work,
   so it is a harness limitation, **not** an app defect — do not "fix" the app
   for it. Real clicks are still exercised pre-login (the sign-in button and
   the login-screen theme toggle both go through `page.click`).

3. **Do not measure the box, measure the TARGET.** A checkbox wrapped in its
   own `<label>` is activated by the whole label; an early version of the
   responsive probe reported six 18x18 "failures" on the Plan screen when the
   real tappable region was 322x44. Equally, `.btn-sm` carries an invisible
   44px `::after` hit area that the border box does not show.
4. **Instrumentation can defeat the thing it is measuring.** A tracer that
   overrode `#view`'s `innerHTML` descriptor *replaced the fix that lived in
   that same descriptor*, so a working guard looked broken. If a probe hooks a
   property, check the fix does not live there too.

## Backend probes (no browser needed)

```bash
node test/tools/probe-transient.js        # 20 checks, offline
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-cors.js    # 10 checks
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-cron.js    # 14 checks
SOAK_N=600 WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-soak.js  # 14 checks
node test/tools/probe-offline-durability.js                        # 12, offline
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-stale-replay.js  # 12 checks

# ADMIN (vendor support seat) — the most commercially dangerous role
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-admin.js             # 88, API
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-admin-ui.js          # 39, browser
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-admin-adversarial.js # 24, hostile-seat

# OWNER (the person who actually pays)
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-owner.js             # 57, API

# MANAGER — two roles in one enum (General = org-wide, Branch = pinned)
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-manager.js           # 62, API

# STAFF — the role that handles cash all day
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-staff.js             # 59, API

# LIFECYCLE — the seams BETWEEN the roles (transfer, promotion, turnover)
WORKER_BASE=http://127.0.0.1:9001 node test/tools/probe-lifecycle.js         # 36, API
```

`probe-cron.js` drives the REAL scheduled handler via
`/cdn-cgi/handler/scheduled` and is **re-runnable** — it clears its own
fixtures first, because a probe that only works on a virgin database is one
nobody runs twice.

### Two more traps, both mine

5. **A file-level coverage check reports green over a real gap.** Asking "does
   this file mention `withD1Retry`?" passed after one of two batch sites in
   `attendanceService` was wrapped. Check per call site.
6. **A schema you guessed is not a schema.** `login_attempts.succeeded` (not
   `successful`), `sync_conflicts.row_id` / `*_version_json`, and
   `idempotency_keys` has no `id` column at all. Read `PRAGMA table_info`
   first; three separate crashes came from not doing so. FK columns
   (`branch_id`, `user_id`) need real ids — a refusal there is the schema
   working, not a bug.
7. **A 400 is usually the app being right.** The soak probe's first run logged
   72 "errors" — all of them `Payments (100) do not sum to sale total (55)`,
   because I read a price from `batch.selling_price` (undefined) instead of
   `selling_price_per_unit`. Same lesson as trap 6: read the real shape.
   `/api/gl/trial-balance` returns an ARRAY of per-account rows, not an object
   of totals — assuming otherwise produced a confident `NaN`.
8. **Sabotage has to fire at the layer that decides the outcome.** My first
   quota simulation fired `onerror` asynchronously *after* the IndexedDB
   request had already succeeded, so `onsuccess` won the race and a perfectly
   good module looked broken. Counting proved it: `add() calls: 1, onerror
   fired: 0, rows persisted: 1`. A real `QuotaExceededError` is thrown BY the
   `add()` call, so the sabotage must throw synchronously too. **If a probe
   says a long-standing module is broken, suspect the probe first.**
9. **A 404 can be the RIGHT answer.** I asserted that an OWNER editing the
   vendor's ADMIN account should get 403. It returns 404 "User not found" — and
   that is better: a 403 would confirm the account exists and is merely
   protected. The vendor seat is hidden, not just locked. Assert the *intent*
   (the client cannot touch it) rather than a status code you assumed.
10. **Check both doors before calling something a gap.** Three "missing
   capability" failures in the first ADMIN run were my own wrong paths:
   `/api/till/sessions` (real: `/api/till`, and Hono 404s the trailing slash),
   `/api/gl/profit-loss` without its required dates, and `/api/attendance/devices`
   without a `branch_id`. The route list is the source of truth, not memory.
11. **A passing test can encode a bug.** The integration suite asserted
   `'deactivating the owner should succeed while a manager is still active'` —
   which is exactly Bug 70. A green suite is evidence that behaviour is
   *unchanged*, not that it is *correct*. When a fix makes an old test fail,
   read the assertion before assuming the fix is wrong.
12. **Stop fighting a guard you just added.** Reworking that fixture took four
   attempts (park left active -> fallback reactivated the owner -> delete hit
   the new guard -> recreate hit 409 because DELETE is a SOFT delete). The fix
   was to assert what the test is actually about — the COMBINED lockout — and
   leave the owner-specific case to its own test.
13. **`is_controlled` lives on the product, not the stock row.** A sale of a
   POM item is correctly refused with 422; picking one at random and reading
   the refusal as a blocker wasted a cycle. Likewise the sale attribution field
   is `served_by` / `served_by_name`, not `sold_by`.
14. **A documented guarantee that was never executed is not a guarantee.**
   AUDIT-REPORT.md stated attendance already refused a manager self-override
   ("can't self-override (403)"). It never did — the claim rode along
   unverified for several passes until Bug 71 executed it. Treat every
   "verified" line in your own notes as a hypothesis until you have re-run it.
15. **Invented endpoints pass for the wrong reason.** I probed
   `POST /users/:id/reset-pin`, which does not exist; its 404 looked like a
   refusal and would have "passed" the takeover check. PINs are reset via
   `PUT /users/:id { pin }`. Similarly the price-override field is
   `default_selling_price`, and that route answers **201** on first creation —
   pinning 200 failed on correct behaviour.
16. **A hidden nav item is not access control.** Bug 72: the Suppliers nav was
   hidden from STAFF in app.js, so nobody checked the endpoint — which had no
   guard at all and returned phone numbers and delivery addresses to any
   cashier. Whenever the frontend hides something by role, go and read the
   route.
17. **The obvious fix can be the wrong one.** Slapping `managerOnly` on
   `GET /suppliers` broke the cashier's Purchase Orders screen, because it
   `Promise.all`s that endpoint. A projection (id+name for STAFF, full record
   for managers) served both needs. Always ask *who else calls this* before
   tightening a route.
18. **A probe that SKIPS is a probe that lies.** Two staff checks were quietly
   skipped on the seeded database ("no suppliers", "no colleague-served sale")
   — including the exact projection Bug 72 was about. Probes must seed their
   own fixtures, not hope for them.
19. **Audit the seams, not just the rooms.** Five passes each audited one role
   in isolation and all came back green. Bug 73 lived in the TRANSITION between
   them — moving a cashier to another branch — which no single-role probe could
   ever have reached. When every component passes, start testing the joins.
20. **Follow your own error messages literally.** The app said "Deactivate this
   account and create the new one"; doing exactly that returned a bare 409
   because the username was held forever by the soft-deleted row. A refusal is
   only as good as the alternative it names — so execute the alternative.
21. **Question the JUSTIFICATION, not just the wording.** Bug 73 accepted the
   premise ("a move would corrupt history") and fixed only the message. One
   `pragma_table_info` sweep plus a forced SQL-level move disproved the premise
   outright: every historical table carries its own `branch_id`, so the Lagos
   sale stayed a Lagos sale. A whole feature was missing behind a refusal
   nobody had tested. When the app says "this is impossible because X", go and
   measure X.
22. **A missing capability shows up as an ASYMMETRY.** Bug 74 was invisible as
   "attendance has no force-close" but obvious as "tills have force-close,
   stocktakes have force-cancel, attendance has nothing". Enumerate every table
   with an open/pending state and ask what closes each one when its owner
   leaves. The odd one out is the bug.
23. **A new code path must re-satisfy the OLD invariants.** Bug 70 protected the
   last Owner against deactivation and deletion. The transfer endpoint was a
   third way to empty the owner seat — demotion — that simply did not exist when
   that guard was written, and nothing but an explicit re-check would have
   caught it. Revert-verified: without it, the only Owner was demoted (200).
24. **Assert the OUTCOME, not the interaction.** The browser probe reported
   "cashier clocks in" green while asserting only that a button had been
   clicked; no shift was ever created, because the clock-in path waits on a
   geolocation callback that never fires headless. Clicking is not doing —
   re-read the resulting state.
25. **Isolate browser state per case, or you are testing the cache.** Running
   seven viewport widths through one browser made every width after the first
   fail to log in ("no editable user found"), which looked exactly like a real
   mobile bug. It was a stale service worker serving an old shell.
   `browser.createBrowserContext()` per case fixed it — the app was never wrong.
26. **Check a threshold against the codebase before calling it a defect.** I
   flagged the new modal's 36px button as too small; `.btn` has had
   `min-height: 36px` app-wide from the start, so "fixing" it would have made
   the new screens inconsistent with every existing one. An arbitrary number is
   not a standard.
27. **"First row" is not a fixture.** After picking the first `[data-edit-user]`
   button, the browser probe failed on "Branch field shown for a Staff member"
   — because the first row is the org-wide General Manager, for whom hiding
   that field is CORRECT. The app was right and the probe was wrong, twice over
   (an earlier version matched a hard-coded name that a previous test run had
   since promoted). Select fixtures by the property under test.
28. **Overflow and reachability are different measurements.** Every responsive
   pass reported the Controlled Register green because the DOCUMENT never
   scrolled sideways — while a 391px button sat in a 320px viewport with 105px
   of it, including its right edge, permanently untappable. The parent clipped
   it silently. Measure whether a control is REACHABLE, not just whether the
   page fits.
29. **Model the stacking context before calling an overlap a bug.** The overlap
   probe's first run produced 95 "failures" that were the CLOSED drawer parked
   at left:-280px, and its second produced 120 that were drawer links correctly
   covering the page behind a scrim. `elementFromPoint` settled it: the scrim
   (z-44, pointer-events:auto) makes the page inert and the drawer (z-45) is
   hittable. An overlay covering the page is an overlay working.
30. **A revert that does not apply proves nothing.** My Bug 76 revert used a
   str.replace that silently did not match (a comment sat between the lines),
   so the "reverted" run measured the FIXED stylesheet and reported a pass.
   Assert that the revert actually changed the file before trusting its result.
31. **The service worker will serve yesterday's CSS to your revert test.**
   `page.setBypassServiceWorker(true)` is the reliable answer; unregistering
   mid-session is not, because the app re-registers on the next load and a
   reload after clearing storage logs the session out.
32. **A summary document must be machine-validated too.** FUNCTIONALITY-
   INVENTORY.md initially passed audit.docs.js while containing a fabricated
   9,999 — the matcher only recognises the phrase "N checks", and the totals
   were in bare table cells. Phrase figures so the existing guard can see them,
   then PROVE it bites by planting a wrong number.
33. **Read the response contract; do not guess field names.** Six "failures" in
   the WHT arithmetic sweep were my probe reading `net_amount` when the API
   returns `net_paid`, producing NaN against perfectly correct maths. Three
   more were VAT "validation holes" that were really me sending `vat_rate`
   when the field is `vat_rate_percent` — the server correctly ignored an
   unknown key. One of those two mistakes was noise; the other led straight to
   Bug 77, because "unknown key silently accepted" is itself the defect.
34. **A 400 that tells you what to do first is the app being right.** The
   supplier-payment WHT test failed with "this supplier is not owed anything at
   this branch". That was correct: a payment presupposes a debt. Following the
   instruction literally (raise a PO, receive it on credit) made the test real
   instead of making the app wrong.
35. **`setBypassServiceWorker(true)` breaks app boot here.** It is the right
   tool for verifying a CSS revert, but the app needs its cached shell to come
   up; with the SW bypassed the plan screen never rendered and it looked like a
   gating bug. Use an isolated browser context per case instead.
36. **Truncating output can invent a bug.** I concluded the VAT and permission
   cards were missing from the Plan screen because my 300-character text dump
   stopped before them. Every element was present. Print what you are asserting
   on, not a prefix of the page.
37. **A revert that breaks the build proves nothing either.** Deleting the
   worked_minutes CASE expression left a dangling comma, so the reverted build
   returned HTTP 500 on the list endpoint. A 500 is not "the feature is absent"
   — it is a broken experiment. Rebuild the statement validly, then measure.
38. **`wrangler dev` hot-reload RESETS the local D1.** Three revert attempts
   reported "no rows" because editing the source wiped the shift I had just
   seeded. Seed AFTER the reload settles, or do a full devserver restart on the
   reverted build and seed then.
39. **Assert what the module CLAIMS to deliver, not just that it does not
   crash.** Attendance passed 32 checks — geofence edges, double clock-in,
   cross-branch fencing, override authority — while never computing a single
   hour. Every check tested a rule; none tested the module's actual purpose.
   Ask "what is this feature FOR?" and test that.
40. **Check how data ENTERS the system before writing a fixture.** I invented
   POST /api/stock to seed batches; it 404s, and my probe read that 404 as
   "receiving expired stock is blocked at the door" — a pass for entirely the
   wrong reason. Stock enters exactly two ways: receiving a purchase order, or
   receiving a branch transfer. There is no direct stock-create route.
41. **Match the ACTOR to the rule you are testing.** I asserted that adjusting
   a Lagos batch while claiming branch_id=minna should fail, and called the 201
   a bug. It was correct: an OWNER is org-wide, so the adjustment is legitimate
   and the false claim is simply ignored (the route authorises and files against
   batch.branch_id). The real threat is a BRANCH-PINNED manager reaching into
   another branch — which is refused 403. Test the threat, not the shape.
42. **Seeded demo data is not neutral.** The concurrency test reported a 422
   and looked like a stocktake bug; the batch I had grabbed was a CONTROLLED
   drug, and the 422 was the POM guard doing its job. Filter fixtures by the
   properties your test depends on.
43. **A new REQUIRED field breaks every fixture that omitted it.** Adding the
   void-reason guard (Bug 80) failed 3 offline checks and 3 integration checks
   that voided with `body: {}` or a 1–3 character stub. None were app faults;
   all were fixtures written when the field was optional. Worse, one of them
   CASCADED: the failed void left its till open, so later `till/open` calls
   failed and an unrelated assertion reported `expected 1000, got undefined`.
   After tightening a contract, read every failure to the end — the loudest one
   is often downstream of the real one.
44. **A guard on one side of a mirrored pair belongs on both.** The supplier
   ledger has refused overpayment since Bug 55; the customer ledger — its exact
   mirror image — never did. Bug 81 was found by asking "does the other side of
   this pair do the same thing?" When a codebase has A/B twins (debtor/creditor,
   in/out, buy/sell), diff their guards deliberately.
45. **Check the ACCOUNTING side and the OPERATIONAL side separately.** Bug 79's
   cash was posted to the GL perfectly — debits and credits balanced, the trial
   balance was exact — while the till reconciliation was blind to it. "The books
   balance" does not mean "the drawer reconciles"; they are different questions
   answered by different code.
46. **Diff the validators across sibling routes.** Bug 82 was found by noticing
   that transfers and adjustments enforce `Number.isInteger` on a quantity while
   purchase orders, receiving and SALES used `Number.isFinite`. Same domain
   concept, four call sites, two different rules. When the same real-world
   quantity is validated in several places, grep the guard and compare them —
   the odd one out is usually the bug, and here it let 2.5 tablets onto a shelf.
47. **A refusal that leaves work stranded is only half a finding.** A transfer
   whose source stock is sold before receipt is correctly refused (no fabricated
   stock), but the transfer then sits PENDING forever. Before reporting that as
   a bug, check whether a resolution path exists — cancel() clears it cleanly,
   so it is a UX gap, not data corruption. Test the recovery, not just the block.
48. **`min="1"` is not integer validation.** Every quantity box in the UI had
   min="1" and no `step`, so a browser happily accepts a typed 1.5 as VALID.
   Only `step="1"` makes a number input reject fractions client-side. The server
   remains authoritative, but the cashier should be stopped at the keyboard.
49. **A missing feature leaves no trace to grep for.** Bug 83 was not a broken
   guard — it was the total ABSENCE of one. `grep -rn credit_limit` across the
   schema, backend and frontend returned NOTHING, and every prior audit passed
   because there was no code to find a fault in. When auditing a domain, list
   what the feature SHOULD have and check for absence, not just correctness.
   "No results" is a finding, not a clean bill of health.
50. **A new NOT NULL column with a restrictive default breaks every fixture
   that relied on the permissive past.** credit_limit DEFAULT 0 halted the
   offline harness outright (a crash, not a failure — zero suites ran and my
   summary reported "0 checks, 0 failures", which looked like success). Nine
   fixtures across offline, integration and my own earlier cash probe created
   customers and immediately sold to them on credit. Read the run's TAIL, not
   just its grep summary: an early crash and a clean pass look identical to a
   counter that never incremented.
51. **Grant fixture privileges through the real endpoint.** Where a test needed
   a credit limit, it now calls PUT /customers/:id as a manager rather than
   writing the column directly. The fixture becomes a second, incidental proof
   that the manager-only setter works.
52. **A guard on a WIND-DOWN action is usually wrong.** Every assertBranchActive
   call blocks work that CREATES something at a branch — a sale, a clock-in,
   opening a till, raising an order — and all of those are correct. Cancelling a
   purchase order is the opposite: it is cleanup, and closing a branch is
   precisely when it is needed. That single outlier stranded a PENDING order
   forever (Bug 84). When a guard fires, ask whether the action ADDS work or
   REMOVES it; the same rule rarely fits both.
53. **Two halves of one billing model must agree.** activeStaffCount filtered on
   is_active; activeBranchCount did not. Deactivating a staff member freed their
   paid seat, closing a branch did not (Bug 85). Neither behaviour is wrong in
   isolation — the defect was that they contradicted each other. Diff the
   counters that feed the same plan.
54. **A probe can destroy its own actor.** My seat-limit test deactivated
   "whichever active STAFF it found first", which was lagos.staff — the account
   every later section used. The result was a cascade of 401s that looked like
   broken branch-closure guards. Hire a disposable fixture rather than
   commandeering a shared one.
55. **A blocked click can hang the whole harness.** Clicking Deactivate fired a
   native confirm(); with no dialog handler, puppeteer sat until
   Runtime.callFunctionOn timed out after ~200s. Register page.on('dialog')
   before driving any destructive control.
56. **Force-scoping protects INSERTs and can silently steal UPDATEs.** The sync
   push overwrote the pushed branch_id with the caller's own — correct when
   creating a row, but on an existing row it REPARENTS it. A Lagos device
   pushing a Minna customer's id overwrote their details and moved them into
   Lagos, while their debt stayed at Minna (Bug 87). When a guard rewrites a
   field rather than checking it, ask what happens when the row already exists.
57. **Read the payload contract before calling a silent no-op a bug.** My first
   push probe sent `changes: [ {table, rows} ]`; the real shape is
   `changes: { customers: [...] }`. The server returned 200 with an empty
   summary — the honest answer to "no known table was named" — and I briefly
   read it as a dropped write.
58. **A 409 on a replayed idempotency key can be the RIGHT answer.** Reusing one
   key with a DIFFERENT body is key abuse, not a retry, and refusing it is
   correct — silently applying the second payload under the first key would be
   the actual bug. A genuine retry is the same key AND the same body.
59. **A test can encode the very bug you just fixed.** An integration test
   pushed edit A as Lagos staff and edit B as MINNA staff and called it a
   "cross-device edit". It is a cross-BRANCH overwrite. The test had always
   passed, which is exactly why the hole survived. Fixing the guard broke the
   test — read such a break as evidence, not as a regression.
60. **Audit the SEAMS between domains, not just the domains.** Eight
   single-domain sweeps all came back green, then a ninth pass that crossed them
   — role change x branch x stocktake — found Bug 88 immediately. The transfer
   guarded an open TILL (money) but never looked at an open STOCKTAKE, because
   stocktakes belong to a different domain than staffing. When each room is
   clean, walk the corridors.
61. **A blocking side-effect is worse than a visible one.** The orphaned
   stocktake was not just untidy: idx_stocktake_one_open_per_branch meant it
   silently BLOCKED the old branch from ever counting again, and the only person
   who knew about it had been moved away. Ask what an abandoned record PREVENTS,
   not just what it looks like.
62. **Probes must not assume seed data survived earlier probes.** probe-crossdomain
   hard-coded /lagos/i and crashed on `undefined.id` after the branch probe had
   relocated and closed branches. Worse, a later run found ZERO active branches
   and reported "0 passed, 2 failed" — which looks like a product failure. Select
   fixtures by PROPERTY (first active branch), and reset the database between
   probes that mutate estate-level state.
63. **Seed data must respect the app's own safety controls.** My scenario seed
   sold from ALL stock, including POM and controlled products, which correctly
   refuse without prescription/KYC (422). Then it priced lines off a sampled
   batch while FEFO filled them from an earlier-expiry batch at a different
   price — "Payments do not sum to sale total" was the app being right and my
   arithmetic wrong. A seed that fights the product produces a screenshot of a
   broken shop.
64. **A stale snapshot inside a loop looks like a product failure.** The seed
   captured the batch list once and sold from it 42 times; quantities fell
   underneath it and most sales failed. Refresh state inside long loops, and
   ALWAYS print the refusal reason — the count alone ("5 of 42") told me
   nothing, the message told me everything.
65. **A CSS fix can trade one misalignment for another.** Bottom-aligning
   controls inside stretched columns fixed a wrapped-label case and
   reintroduced the original 166px helper-text gap. Re-measure EVERY case the
   rule touches, not just the one you were chasing — 7 screens x 4 widths here.
66. **A guard stricter than the write it protects is a bypass, not defence.** The
   UPDATE coerced (`is_active ? 1 : 0`) while three guards asked
   `is_active === false`, so the number `0` — which is what every integration,
   curl call and round-tripped record sends — skipped all of them and wrote
   anyway. Bug 91 re-opened Bugs 70, 74 AND 86 through one type mismatch. When
   auditing a guard, do not only ask "is the rule right"; ask **"can the write
   be reached by a value the guard does not recognise as the same instruction"**.
   Fix with a SHARED reader, never with N corrected comparisons.
67. **An overflow measurement is not a reachability finding.** My screenshot pass
   flagged 60 captures where an element extended past the viewport and I nearly
   reported them. All 60 were tables inside `overflow-x:auto` wrappers, which is
   how a wide table is SUPPOSED to work. The real question is whether scrolling
   every scrollable ancestor brings the element into view — so the probe must
   actually SCROLL and re-measure, not compute a rectangle.
68. **A "failing" probe is guilty until proven innocent — check the probe first.**
   My first reachability probe reported 3,384 unreachable controls. Every one was
   the CLOSED off-canvas nav drawer sitting at `left:-280px` by design. I had
   measured a state the user never sees, and counted "not currently on screen" as
   "cannot be reached". Before believing a mass failure, ask what state the app
   was actually in and whether the assertion describes something a user would
   ever experience. Audit the drawer OPEN — that is the state that exists.
69. **A grouping rule that discards the outlier can never see the outlier.** My
   form-alignment probe bucketed controls into "rows" by vertical proximity
   (within 30px), then measured the spread inside each bucket. The one button
   that was 40px out fell outside every band, became a bucket of one, and was
   skipped — so the probe scored a clean 36/36 on a row I had ALREADY measured
   as broken by hand. Never group by the same dimension you are testing. Group
   by something independent (here: X, since a flex wrap is where `left` stops
   advancing) and let the tested dimension vary freely.
70. **Geometry is not visibility — vertically too.** The overlap probe already
   ignored horizontally-scrolled and off-canvas content, but not content
   scrolled out of a `max-height` + `overflow-y:auto` box. Two tables on one
   page, and a row rendered 93px below the fold of the first reported a 68%
   "collision" with a button in the second. Before believing any geometric
   finding, ask whether BOTH elements are actually on screen and hittable.
71. **After teaching a probe to ignore something, prove it still catches the
   real thing.** Adding the clipping rule above could just as easily have
   blinded the probe. I re-ran it against a deliberate sabotage
   (absolutely-positioning every form button over the form) and confirmed it
   still reported collisions on 3 screens before restoring. An exclusion you
   have not sabotage-tested is an exclusion you do not understand.
72. **`scrollWidth === clientWidth` does NOT prove a <select> is not clipped.**
    Sizing the branch switcher, the DOM reported no overflow while the control
    visibly read "All Branche" with the last letter sliced off. A <select>
    renders its selected text inside a shrink-to-fit box that Chromium does not
    report as overflowing. Measure the TEXT against the box using the element's
    own computed font (canvas measureText), and confirm with a screenshot —
    two independent signals, because the cheap one lies here.
73. **When a fix is "make X smaller", the constraint may be the CONTENT.**
    The client asked for a narrower switcher; capping the width alone produced
    a control too small for its own label. At 320px the widest the box can be
    while clearing the brand mark is 102px, and "All Branches" needs 121px —
    no width satisfies both, so the LABEL had to shorten per breakpoint. Check
    whether the thing being resized can still say what it needs to say.
74. **A GL poster returns `{ entryId, statements }`, not an array.** Spreading
    the object appended nothing: the change-owed claim, its 7-digit code and
    the receipt were all correct while CHANGE_OWED_PAYABLE never moved and the
    drawer stayed N100 short. The sale returned 201 throughout. Caught only
    because the probe asserted the LEDGER and the DRAWER rather than the
    status code — assert the consequence, never the response.
75. **SQLite cannot ALTER a CHECK constraint, and it will not drop a table a
    VIEW still references.** Adding three source types to gl_journal_entries
    needed a full table rebuild, and that failed until v_gl_account_balances
    and v_gl_account_balances_total were dropped and recreated around it. The
    CHECK refusing an unknown source type is the schema doing its job — better
    to be stopped than to accumulate rows with an unrecognised event type.
76. **A new per-transaction table must be added to the storage cost model, and
    a new route must be reachable from the UI.** Both were caught by existing
    go-live guards within minutes of the feature landing — `change_owed` was
    missing from ROW_COST_BYTES, and two endpoints I had written were called by
    nothing. Measure the row cost (5,000 rows, VACUUM either side) rather than
    guessing it: change_owed came out at 564 bytes, well above the 220-260 of
    the other ledger tables because of its summary text and six indexes.
77. **A richer seed breaks fixtures that "worked" by luck.** Growing the seed to
    8 branches and 35 staff turned 5 probes red at once — 45 apparent failures,
    every one mine. Three distinct causes, all the same shape: the probe
    assumed something the seed used to guarantee. It picked a batch and priced
    against it (FEFO fills from a DIFFERENT batch — now `lib-fefo.js`); it
    matched a creditor row by supplier alone (the view is grouped by supplier
    AND branch, and the supplier now owes at two); it opened a till at a branch
    that already had one (409 is one-per-branch working). Before believing a
    mass failure after a fixture change, ask what the seed used to guarantee
    that it no longer does.
78. **Assert the RULE, not the mechanism that usually satisfies it.** The
    cross-domain probe checked "they can trade at the new branch" by opening a
    till and requiring 201. A 409 TILL_ALREADY_OPEN also proves they are
    admitted — the refusal is about the branch's single drawer, not about them.
    The check now accepts either and would still fail on a 403 scope violation,
    which is the thing actually under test.
79. **A guard added to the app will break test fixtures that were never
    realistic.** Bug 96's cash-floor guard failed three suites that paid
    N5,000-N9,000 of expenses out of a N1,000 till. They were not wrong tests;
    they were tests encoding an impossible shop. Fixing them meant making the
    fixture real (fund the float), not weakening the guard — and their failure
    was itself evidence the guard was needed.
80. **`UI.on()` takes an ID, not a selector.** I wrote `UI.on('#safe-go', …)`
    and three `UI.on('#co-…')` calls; `getElementById('#safe-go')` matches
    nothing, so all four handlers bound to nothing and failed SILENTLY — no
    error, no console warning, just a button that does nothing. Found by
    watching the network panel: the GET fired on load, the POST never did.
    When a control does nothing, check the binding before the handler.
81. **A message that reads reasonably can still be a dead end.** Five screens
    told a Branch Manager "Select a specific branch to manage its till" — a
    sentence that is CORRECT for an owner choosing which shop to act on, and
    impossible for someone with no switcher. It survived because the screen was
    not blank and the text was not wrong, only unactionable for that role.
    Ask not "does this render" but "can THIS role act on what it renders".
82. **When N files copy the same expression, the bug is N-way.** Thirteen views
    each hand-computed branch scope with the same ternary, and every one of
    them was wrong for the same role. The fix is one shared helper, never
    thirteen corrected copies — and the giveaway was that the expression was
    identical in all thirteen, which means it was never really per-view logic.
83. **A capability the backend grants must have a door in the UI.** POST
    /api/expenses has always accepted a cashier — the person sent to buy diesel
    IS the cashier — but the nav link and the whole screen were hidden from
    STAFF because LISTING every expense is manager-only. One rule (read) was
    used to gate a different action (write), so a granted power had no route.
    It also made the drawer/safe split unreachable for the role that needs it
    most. When gating a screen, ask which VERB each control uses.
84. **0 must be allowed to mean "no limit" — and never silently mean "none".**
    The client asked for a staff safe allowance that could be capped OR
    uncapped. Using 0 for "unlimited" is only safe because a separate boolean
    carries the can/cannot decision; conflating the two would have banned all
    staff spending the moment someone typed 0 meaning "no ceiling". Assert both
    readings in the probe, not just the one you implemented.
85. **A split payment must be netted out of BOTH reconciliations.** The till
    subtracts `expenses.amount` for anything marked CASH, so a N20,000 purchase
    funded N8,000 drawer + N12,000 safe charged the drawer the whole N20,000 —
    a N12,000 phantom shortage for a cashier who did nothing wrong (the Bug 79
    and 96 class, third occurrence). Whenever money can come from two places,
    every reader that assumed one place is now wrong.
86. **Snap money at the boundary, or the ledger will do it for you and fail.**
    A caller sending `price * 0.95` (110.705) produced debits of 110.71 against
    credits of 110.705 and the sale died with the GL's internal wording shown
    to the counter. Bug 52 fixed exactly this for expenses; sale payments were
    never given the same normaliseMoney() call. When a fix is described as
    "at the boundary", check EVERY boundary.
87. **Middleware that exists is not middleware that is applied.** The
    idempotency layer had been written, tested and documented — and was wired
    to exactly three routes. Every other money path (safe movements, supplier
    payments, debtor repayments, stock write-offs, till close, transfers)
    doubled on retry. Nothing failed, because no test ever sent the same
    Idempotency-Key twice to those endpoints. Grep for where a safety layer is
    USED, not whether it exists.
88. **A meta-audit finds what the tests cannot.** Enumerating every registered
    route and diffing it against the whole test corpus proved coverage was
    essentially complete — which is exactly why the remaining bug was NOT a
    missing route but a missing PROPERTY (retry safety) on routes that were all
    well covered. When coverage looks total, change the question: not "which
    endpoint is untested" but "which INVARIANT is untested everywhere".
89. **Not every surprising result is a bug — force-scoping can look like one.**
    A cashier POSTing an expense with another branch's branch_id returned 201,
    which reads as a scoping breach. It was not: resolveMutationBranchId had
    force-scoped the row back to their own branch, which is correct. Check
    WHERE THE ROW LANDED before reporting the status code.
90. **Test the REVERSAL, not just the action.** Every round so far verified that
    an action posts correctly. None asked whether UNDOING it puts the world
    back. That blind spot hid Bug 102 for four rounds: voiding a sale reversed
    the stock, the debtor ledger and the GL, but left its change claim
    OUTSTANDING — the shop owed N100 for a sale that no longer existed, and the
    customer could collect it on top of their refund. For every create, ask
    what the delete/void/cancel path forgets.
91. **A reversal must not rewrite history that really happened.** The fix
    cancels a change claim on void — but ONLY while it is still outstanding. A
    claim the customer already collected stays SETTLED, because that money
    genuinely left the drawer and erasing the record would make the till short
    with nothing to explain it. Same reasoning as reversing a debtor DEBIT with
    a new PAYMENT row rather than deleting it.
92. **An icon is a product decision, not a decoration.** The previous icon was
    navy and gold; the entire application is deep green (#0a3b2c topbar). It
    looked like a different product's logo pasted onto the app. Sample the
    real palette from the stylesheet before designing anything that has to sit
    beside it, and test the result at 48px — the phone home screen is the
    actual use case, not the design review.
93. **A floor without a ceiling is half a guard.** validateMoneyAmount had
    policed sub-kobo amounts since Bug 41 and nobody had asked the opposite
    question. A deposit of 1e15 was accepted and the safe reported
    N1,000,000,000,152,074.4 — a figure that has ALREADY lost precision, since
    1e15 naira is 1e17 kobo and JS holds integers exactly only to ~9.007e15.
    Adding a kobo to it is a silent no-op. Revert-verified the books actually
    go UNBALANCED without the cap. For every minimum, ask what the maximum is.
94. **Free text needs a maximum too, and for three separate reasons.** A
    200,000-character reason was stored verbatim: it bloats a database with a
    500 MB ceiling this deployment already warns on, it is loaded into every
    list that shows the row (on a phone, over mobile data), and it is a trivial
    denial-of-service. A minimum length is not validation on its own.
95. **A sign can be DIRECTION, not an error — check the outcome.** My probe
    reported "a negative DEPOSIT returned 201" as a bug. The route takes
    Math.abs() deliberately, because TILL_TRANSFER carries direction in the
    sign while DEPOSIT and WITHDRAWAL take it from the verb. A -500 DEPOSIT
    correctly deposits N500. The check now asserts the BALANCE MOVED, which is
    the thing that actually matters, instead of the status code.
96. **Closing a bug class means closing the CLASS, not the column.** Bug 103
    capped every money amount and the "unbounded number" class was written up
    as finished. Bug 104 was the same defect one multiplication away: the GL
    posts `quantity x unit_cost`, so an uncapped QUANTITY reaches the ledger
    with an oversized figure while every individual value still looks sane. A
    PO for 1e15 units at a legal N100 each threw the trial balance out by N4.
    When you cap one input to a calculation, cap the OTHER operands too.
97. **A regression test can pass for the wrong reason and prove nothing.** My
    first "receiving rejects a huge quantity" check received 1e15 against a PO
    that had ordered 10 — so the refusal came from the
    `quantity_received <= quantity_ordered` CHECK constraint, not the guard
    under test, and it stayed GREEN with the fix reverted. Every new guard must
    be revert-verified individually; a suite that goes red overall is not
    evidence that each check inside it works.
98. **Some invariants are real but unreliable as detectors.** "The trial
    balance balances" is a true and important property, yet as a test for Bug
    104 it was silent about half the time: whether the float error surfaces
    depends on the specific magnitudes. The dependable signal was "no account
    holds a balance larger than any real pharmacy could transact". Keep both,
    and know which one is load-bearing.
99. **An icon is not done until it is tested under the crop that ships it.**
    The premium lockup looked perfect at 512px and under an inscribed-circle
    preview. Under Android's DOCUMENTED maskable safe zone (the centre 80%
    DIAMETER circle) it read "HARMARIDG" — the wordmark's first and last
    letters sliced off. A full-bleed band cannot be made safe by scaling: it
    runs to the edge by definition. It needed a different COMPOSITION (a pill
    with a finite bounding box, fitted by its half-diagonal), not a smaller
    one. Composite the real mask over the real PNG; never trust the preview.
100. **Two artefacts that must agree will disagree unless one generates the
    other.** The topbar mark lived hand-written in index.html with no
    relationship to the icon files, so the app chrome could show a different
    logo from the install icon and nothing would catch it. The build now writes
    index.html, and a probe asserts the geometry on disk still matches what the
    build emits.
101. **Opacity and hairline strokes are not available below ~24px.** Three of
    five topbar candidates failed at 20px for the same reason: a .55-opacity
    ridge disappeared into the topbar green, and a 1.8px stroke rendered as
    pale grey rather than white. Solid fills and at most two peaks are what a
    20px mark can actually carry. Judge it at the size it ships, on the real
    background colour.
102. **A receipt is not a screen — print it and read the paper back.** Every
    round until now checked receipts by reading the HTML or looking at the
    on-screen preview, and the preview was perfect. Printed to a real 80mm
    page, the change-claim instruction stopped mid-word at "...or use i". The
    only question that matters for a receipt is WHAT LANDS ON THE PAPER, and
    the only way to answer it is to render to the real page size and extract
    the text.
103. **`:last-child` is a trap when a cell can be empty.** `.r-line
    span:last-child { white-space: nowrap }` was written to stop a money amount
    wrapping away from its label. On a line with an EMPTY right cell the FIRST
    span is also the last child, so long text silently inherited nowrap. When a
    rule means "the second one", say `nth-child(2)`, not "the last one".
104. **Do not generalise a defect before testing the general case.** I assumed
    long product names were also being truncated. They were not — they wrapped
    correctly and the price survived. Checking first kept the fix narrow and
    kept the write-up honest; claiming a wider blast radius than exists is its
    own kind of wrong.
105. **A syntactically broken shipped file is invisible to a test suite that
    crashes.** Backticks inside a template literal left export.js unparseable —
    every Print/PDF/CSV button dead — and the offline suite did not report a
    failure, it *crashed* at check 461 with a stack trace that reads like a
    broken harness. A suite that stops early is not a passing suite. Parse
    every shipped file explicitly.
106. **Revert-verification is invalid unless the server actually reloaded.**
    Twice in one session my revert test reported the OPPOSITE of the truth
    because `wrangler dev` was still serving the previous file. Restart, wait,
    and confirm the change is live before believing either a pass or a fail.
107. **An epsilon comparison can fail for the exact cases it exists to catch.**
    My one-kobo tolerance `Math.abs(residue - wht) <= 0.01` did not fire,
    because |0.51 - 0.52| is 0.010000000000000009. I had written a
    floating-point guard against a floating-point problem. Compare whole kobo
    as INTEGERS instead of tuning the epsilon.
108. **Accepting a tolerance and then refusing to honour it is a bug in
    itself.** createSale deliberately allowed a sale to settle one kobo off,
    then handed the unreconciled figures to a ledger that requires exact
    balance. Wherever a boundary is lenient, every consumer downstream must be
    told which figure to use — or the leniency is a trap.
109. **Reproduce arithmetically before blaming the server.** Working the
    rounding out on paper turned one intermittent probe failure into a
    predictable list of six prices and a measured rate (35 of 1,001). That
    changed the bug from "flaky" to "one contract sale in 29", which is what
    made the severity honest and gave the probe real inputs.
110. **Measure the deliverable, do not admire it.** The client asked for no
    page over 50% empty. Rasterising every page and measuring where the ink
    stops found 69 of 117 — but only after the first attempt scored every page
    at 97.9% because the running FOOTER inks the bottom of all of them.
    Exclude the furniture before measuring the content.
111. **Offline-capable means testing the COLLISION, not the round trip.** Every
    earlier round tested sync by queueing work and replaying it into an
    unchanged world. Both Bug 107 and Bug 108 live in the case nobody had
    written a test for: work that was VALID when it was created arriving after
    a manager changed something underneath it. For every offline-capable
    action, ask what a manager could legitimately change in the meantime.
112. **A refusal with no way forward is worse than a wrong answer.** The
    transfer receive returned a correct, honest 400 — and left 153 units
    unsellable at both branches with no partial-receive route out. Correct and
    unusable is still broken. When a guard fires, check there is a path the
    user can actually take.
113. **A client correcting your DOCUMENTATION may not mean the code is wrong.**
    The plan-limit rule was already enforced exactly as the client described;
    only my wording described it as a metered allowance. I verified the
    backend before changing anything and found nothing to fix. Do not "fix"
    working code to match a complaint about prose.
114. **Two halves of a symmetric feature should be symmetric.** A stock
    transfer required the receiver to confirm; a STAFF transfer required
    nobody. The asymmetry was invisible until the offline case was tested,
    and the fix was to make people work the way stock already did. When one
    kind of transfer has a confirmation step, ask why the other does not.
115. **Adding a confirmation step adds a new way to get stuck — plan the
    escape hatch in the same change.** Confirmation-first would have stranded
    a transfer for anyone who resigned or lost their phone. The force path
    was written at the same time, restricted to org-wide authority, and
    recorded distinctly so consent and imposition are never conflated.
116. **UI.closeModal() takes the element; calling it bare is a SILENT no-op.**
    The confirm button worked — the API call succeeded, the move applied — and
    the modal simply stayed on screen. Nothing errored. Same family as the
    recorded `UI.on()` trap: this codebase's helpers fail quietly by design,
    so a browser check is the only proof a control did what it looked like it
    did.
117. **An icon probe can pin a DESIGN instead of a property.** My own
    icon checks asserted "a gold nameplate reaches the bottom edge" and went
    red when the wordmark was deliberately moved into the background. The
    property worth protecting was "the artwork is full-bleed" and "the name
    occupies real space at the smallest size" — not the slab it used to sit
    on. Trap #43 applies to pixels as much as to source text.
118. **A top-level `const` is NOT on `window`, and `(window.X && X.y())` is a
    guard that never fires.** This idiom appears defensive and reads as
    correct. In a classic script it is permanently false, so the fallback is
    taken silently forever — here, every receipt and printed report carried
    OUR name instead of the client's, on every white-labelled deployment,
    since day one. Nothing errored because the fallback looked deliberate.
    Grep for `window.X` where X is declared with `const`.
119. **When a client asks for a feature you already built, TEST that claim —
    do not answer from memory.** Promotions were already staged and
    confirmed, because a role change shares the transfer endpoint. Saying so
    without proof would have been a guess; the probe turned it into a fact,
    and writing it exposed Bug 109 in the same pass.
120. **Consent requires comprehension.** The staging worked perfectly and the
    dialog said "You are being moved to Rivertown Pharmacy" to somebody
    already at Rivertown. A correct mechanism wrapped in an incoherent
    message is not a working feature — the person clicking the button is part
    of the system.
121. **A preview must be styled by the same rules as the thing it previews.**
    The receipt preview rendered thermal markup with no thermal CSS on the
    page, because those rules lived only in the string injected into the
    print frame. It looked like a bug in the receipt and was a bug in the
    preview. Where one renderer serves two surfaces, check BOTH surfaces.
122. **A screenshot harness that copies production CSS will drift from it.**
    shots-artefacts.js held a hand-written duplicate of THERMAL_CSS. The
    moment the real one gained the "Powered by" line, the manual silently
    kept photographing the OLD receipt — pictures of a product that no longer
    exists. It now reads the shipped stylesheet. Never re-type what you can
    read.
123. **Wait for the DATA the renderer needs, not just for the session.** The
    artefact harness waited on `gl_pms_session` and rendered before
    `Branding.load()` resolved, producing plates headed with the fallback
    name. The app was right; the harness was racing it. Waiting on "logged
    in" is not the same as waiting on "ready".
124. **Text extracted from a PDF wraps, so match on collapsed whitespace.** My
    pairing check counted 2 of 30 phone captions and I briefly believed the
    document was broken — the caption sits in a 34mm column and wraps as
    "The same screen on a / phone". Collapse whitespace BEFORE matching.
125. **"Hidden from the menu" does not imply "must 403".** My role-trigger
    probe flagged /products and /suppliers as leaks for STAFF. Both are
    deliberate: a cashier needs the catalogue to sell, and /suppliers returns
    them an id+name projection so the PO dropdown works. The SCREEN is
    manager-only; the read is not. Check the design intent before calling a
    200 a breach.
126. **A field that is accepted and ignored is worse than one that is
    rejected.** `unit_type: 'CARTON'` on a goods-received line returned 200
    and recorded 10 capsules where 1,000 arrived. The caller had every reason
    to believe it worked. If an input is not honoured, refuse it loudly —
    silent acceptance is how a stock file ends up wrong by two orders of
    magnitude with nobody looking for a cause.
127. **Two halves of one product must agree on their units.** Sales understood
    CARTON/PACK/BASE_UNIT; receiving understood only pieces. The asymmetry sat
    there through every previous audit because each half was tested against
    itself. When a vocabulary exists in one direction, check the other.
128. **Ask for the number the human actually has.** The supplier invoices a
    total; nobody writes down a per-tablet cost. Demanding the derived figure
    makes the operator do arithmetic at a delivery door and silently corrupts
    every margin when they slip a decimal. Take the total, derive the rest,
    and show the derivation before committing.
129. **Do not round a derived unit cost.** 480,000 / 7,000 = 68.5714…; rounding
    to kobo and multiplying back values the stock N0.20 under what was paid,
    on every awkward delivery, forever. Keep full precision for valuation and
    round only for display — the reconciliation test is `cost × qty == invoice`.
130. **A preview and its authority must share one implementation.** The live
    "10 cartons = 1,200 pieces" line and the server's conversion are the same
    module. A preview computing one number while the server stores another is
    the exact bug being fixed, reintroduced through the front door.
131. **Adding a per-batch fact obliges you to find every reader of the old
    per-product fact.** Bug 112 moved pack/carton nesting onto the batch.
    Pricing already read the batch; QUANTITY still read the product, so one
    sale had two authorities and a customer paid for 24 bottles and got 10.
    After relocating a source of truth, grep for every consumer of the thing
    it replaced — not just the one you were thinking about.
132. **A field that is written and never read is half a feature.**
    `selling_pattern` was stored on every batch by Bug 112 and consumed by
    nothing. The inverse of trap #83: not a capability without a door, but a
    record without a reader. Either surface it or do not store it.
133. **A visible label is not an announced label.** `.form-row > label +
    input` reads correctly to a sighted user and is silent to a screen
    reader. 47 fields shipped that way through a dozen audits because every
    check asked "is there label text" and none asked "is it associated".
134. **Fix a 98-site convention at the funnel, not at the sites.** Editing 98
    markup locations invites the 99th to be forgotten. One pass in the
    router's single render path means a NEW screen inherits the behaviour.
135. **A syntactically valid file can still be structurally broken.** My
    helper landed INSIDE navigate(), splitting it in two. `node --check`
    passed; the app died with "associateFormLabels is not defined". Verify
    WHERE an insertion landed, not just that the file parses.
136. **A cleanup registered during navigation runs on THAT navigation.**
    `navigate()` calls `runCleanup()` at its start, so registering an
    observer teardown via `onCleanup()` tore it down before the screen it was
    watching had rendered. Measured: 3 mutations fired, none handled.
137. **My own probes produced three false alarms in one sweep, and each would
    have caused real damage if believed.** (a) Elements wider than the
    viewport inside `overflow-x:auto` are the intended design, not overflow —
    the page never scrolled. (b) An 18px checkbox is fine when its <label> is
    a 44px target; measure the EFFECTIVE target. (c) A sibling label is a
    genuine a11y gap but not a missing label — reporting it as "no label"
    conflated two different severities. Check what the design intends before
    calling a measurement a defect.
138. **After moving a fact onto a row, find everything that COPIES that row.**
    Bug 113 fixed the reader; Bug 115 was the same defect in the copier. A
    transfer duplicated a batch, brought the prices and left the nesting NULL,
    so stock reverted to the product default the moment it crossed a branch.
    "Who reads this?" and "who copies this?" are two different questions and
    both need asking.
139. **When copying a record, decide field by field what TRAVELS and what does
    not.** The pack size is a property of the goods and must travel. The
    delivery count and the invoice total are properties of the DELIVERY and
    must not — copying them would make the destination's goods-received note
    claim a delivery that never arrived there.
140. **Chain probes find what feature probes cannot.** Every existing probe
    tested one feature against itself and all were green while Bug 115 was
    live. Following ONE delivery through receive → transfer → sell → write-off
    → stocktake → void found it immediately. Test the seams, not the parts.
141. **Annotating a failing test is a debt, not a fix.** I left probe-transfer
    section G failing 8 checks with a comment explaining the drift. It stayed
    red for three rounds and made every later run harder to read. The actual
    cause took ten minutes: the fixture had already been moved to the branch
    the section tried to move it to.
142. **Four of my probe calls used the wrong API shape in one sitting**
    (`/ledger` vs `/balance`, `/repayments` vs `/payments`, `TILL` vs `CASH`,
    `credit_limit` at create). Each looked like an application bug for a
    moment. Read the route table before believing a 400 or a 404.
143. **An intermittent test is a defect report you have not read yet.** I
    labelled probe-accounting "cross-probe seed contamination, passes on a
    fresh DB" for several rounds. Behind it was Bug 116: cash moved from the
    safe into the drawer was invisible to the till, so money physically in the
    box could not be spent and produced a phantom overage at close. The
    intermittency WAS the symptom — the probe only failed once the seeded
    float ran out, which is exactly when the missing leg started to matter.
144. **"Passes on a fresh database" is not a property worth having.** A probe
    that spends cash and never replaces it degrades the world it runs in, so
    it works twice and fails on the third run. Either restore what you
    consume, or provision what you need at the start — and ASSERT the setup
    succeeded, or its silent failure becomes someone's afternoon.
145. **Check the response of a setup call.** My drawer top-up used
    `movement_type` where the field is `entry_type`. It 400'd, nothing looked
    at the status, and the failure surfaced later as an unrelated assertion
    about withholding tax. Fire-and-forget setup is how the wrong thing gets
    debugged.
146. **Freeze migrations the day a client exists, and make the rule
    executable.** Editing an already-applied migration is never re-run by
    wrangler, so local and production diverge in silence. Documenting that is
    necessary and insufficient; audit.docs.js now checks the guidance exists,
    that files are numbered contiguously, and prints the frozen files'
    checksums so an edit shows up in review.
147. **Fixing a blind spot can expose what the blindness was hiding.** Bug 116
    made safe<->till transfers visible to the drawer. That immediately made
    Bug 117 reachable: you could now sweep the drawer negative, because the
    guard that protects a cash EXPENSE had no counterpart on a TRANSFER. When
    a figure starts moving that never moved before, re-ask every "can this go
    negative" question about it.
148. **The same physical act must be guarded on every verb that performs it.**
    Money leaving the drawer was refused as an expense and permitted as a
    transfer. A user does not experience "an expense" and "a transfer" — they
    experience cash leaving the box. Enumerate the ACTS, not the endpoints.
149. **An event with no owner will be adopted by the next owner.** An expense
    recorded while no till was open was swept into the next session's window
    and charged to a cashier who never spent it. Anything windowed by time
    needs an explicit answer for events that fall outside every window —
    record it at write time, when the truth is still known.
