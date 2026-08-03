# Recovery Status and Evidence Boundary

## What was recovered

The source attachment was preserved unchanged at:

- `/home/user/uploads/7.txt` — original upload
- `provenance/SOURCE-ARTIFACT-7.txt` — immutable project-local preservation copy

SHA-256 of the preserved artifact:

```text
b0fd19e76576475e06360a2a1d29163ea4d39bbd585412c16a6ef533e9302d39
```

The artifact was a 38,605-line concatenation rather than a filesystem archive. The reconstructed repository separates it into 103 recovered text files plus this recovery documentation, a structural verification test, a deployment preflight, and regenerated PWA icons.

## Boundary-selection method

File boundaries were selected only from explicit structural evidence:

- SQL migration headings and statement boundaries;
- JSON object boundaries for Wrangler/package/manifest files;
- CommonJS module exports and the next module declaration;
- Hono `new Hono()` route module declarations;
- Worker `export default` boundary;
- browser IIFE completion / `window.*` publication;
- named frontend view render-function declarations; and
- HTML, service-worker, and Markdown headings.

The artifact contains two near-duplicate copies of `.gitignore`, the NAFDAC catalog builder, and the route-reachability utility. The complete, later copies were selected where they included the missing heading/comment preamble. The original blob remains the evidence source if a future reviewer needs to compare those variants.

## Validation completed on 2026-08-04

| Check | Result |
|---|---:|
| JSON (`package.json`, lockfile, manifest) | Valid |
| JavaScript syntax (all recovered source modules) | Valid |
| Relative Worker `require()` resolution | Valid |
| Mounted Hono routes ↔ route files | 27 / 27 valid |
| HTML / manifest / service-worker static asset references | Valid |
| SQLite execution of both migrations | Valid |
| Schema after both migrations | 41 tables, 14 views, 64 indexes, 1 GL-balance trigger |
| NAFDAC catalog rows after migration | 6,801 |
| Default client-settings rows | 1 |
| Default GL accounts | 19 |

Run the repeatable structural check with:

```bash
cd worker
npm test
# equivalent: npm run verify:structure
```

The migration compatibility check uses Python's standard-library SQLite in this environment; it is not a substitute for applying the migrations through remote Cloudflare D1.

## Deliberate additions made during recovery

These files are new and are not claimed to have existed in the attachment:

- `tools/reconstruct-from-artifact.py` — repeatable, range-recorded source extraction from the original artifact;
- `tools/reconstruct-test-artifact.py` — repeatable, range-recorded extraction of the supplied test artifact;
- `test/reconstruction.verify.js` — source-tree, wiring, and PWA asset verification;
- `worker/tools/preflight.js` — deployment guardrails for Node version, D1 ID, and required assets;
- `worker/.dev.vars.example` — a safe local-secret template;
- `public/branding/pharmaridge-logo.png` — the supplied original PharmaRidge logo artwork;
- `public/branding/pharmaridge-mark.png` — a small in-app crop derived from that supplied artwork;
- `public/icons/*.png` — deterministic PWA icon output from the restored `worker/test/tools/build-icons.js` artwork source;
- `docs/*` — recovery, architecture, and operational documentation; and
- `DEPLOY-FROM-WINDOWS.md` — the formerly missing Windows deployment guide.

## Restored test evidence — 2026-08-04

A second supplied artifact, `test.txt`, restored the core audit, browser, icon, scenario, screenshot, and manual-generation sources. It is preserved at `provenance/TEST-ARTIFACT.txt` with SHA-256:

```text
373e197cb09e02637ac620c5106bf44eaa7c38e819e8ee47f1ca41090e54a38d
```

The restored suite contains 60 JavaScript files. All parse, and the following evidence has been executed against a fresh local Wrangler D1 database under Node 22.23.2:

| Command / probe | Result |
|---|---:|
| `npm run assets:icons` | Built all PWA icon variants from one SVG artwork source |
| `npm run test:icons` | 35 passed, 0 failed |
| `npm run test:live:core` | 227 passed, 0 failed across four isolated databases |
| `audit.pwa.js` browser/theme/accessibility probe | 127 passed, 0 failed |

`worker/test/README.md` documents the restored layout and commands. `npm test` remains the fast structural verifier; use `npm run test:live:core` for the fresh-D1 core behavioural gate.

## Still not recovered — do not overstate certification

The source still does not include every historical filename referenced by the old aggregate package scripts — notably the original `integration.test.js`, original dev-server variants, and some historical audit aggregators. Nor does it include a Git history before recovery, a remote origin, Cloudflare account configuration, a real production D1 ID, a production JWT secret, a deployed Pages project, or a custom domain route.

Therefore historical totals in `AUDIT-REPORT.md` and `PROJECT-SETUP-STATUS.md` remain **artifact assertions**, not production certification. The project is materially better evidenced than at initial recovery, but remains **not production-approved** until the staging/remote controls in `docs/PRODUCTION-READINESS.md` are completed.
