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
- `test/reconstruction.verify.js` — source-tree, wiring, and PWA asset verification;
- `worker/tools/preflight.js` — deployment guardrails for Node version, D1 ID, and required assets;
- `worker/.dev.vars.example` — a safe local-secret template;
- `public/branding/pharmaridge-logo.png` — the supplied original PharmaRidge logo artwork;
- `public/branding/pharmaridge-mark.png` and `public/icons/*.png` — purpose-cropped/resized PWA icon variants derived from the supplied artwork;
- `docs/*` — recovery, architecture, and operational documentation; and
- `DEPLOY-FROM-WINDOWS.md` — the formerly missing Windows deployment guide.

## Not recovered — do not treat as certified

The attachment did **not** include the test files referenced by the original `package.json` (`worker/test/audit.*`, integration tests, dev-server scripts, browser probes, and related fixtures). It also did not include a Git history, a remote origin, Cloudflare account configuration, a real D1 database ID, a production JWT secret, a deployed Pages project, or a custom domain route.

For that reason:

1. `npm test` now runs the recovered structural verifier, not the historical 2,283-check behavioural suite.
2. `npm run test:artifact-suite`, `npm run test:integration`, and `npm run test:live` remain historical command definitions and will not run until their absent test sources are restored.
3. Historical test totals and audit claims in `AUDIT-REPORT.md` and `PROJECT-SETUP-STATUS.md` are **unverified artifact assertions**, not current certification.
4. This repository is suitable for controlled local reconstruction work, but it is **not production-approved** until the production checklist is completed and the missing functional tests are restored or replaced.
