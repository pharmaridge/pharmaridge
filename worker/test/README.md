# Restored Test and Evidence Suite

This directory was reconstructed from the supplied `test.txt` artifact on 2026-08-04.

- Artifact copy: `provenance/TEST-ARTIFACT.txt`
- SHA-256: `373e197cb09e02637ac620c5106bf44eaa7c38e819e8ee47f1ca41090e54a38d`
- Recovered: 60 JavaScript files, one shared FEFO fixture helper, one testing playbook, browser/icon tooling, screenshot/manual tooling, and the core live-audit runner.

## Layout

- `audit.*.js` — API/domain audits such as cash accountability, WHT/GL, procurement, transfer and sync behaviour.
- `tools/` — browser, icon, scenario-seeding, screenshot, and document-generation tools.
- `tools/probe-*.js` — focused regression/adversarial probes. They live under `tools/` because their source resolves project paths relative to that directory.
- `TESTING-PLAYBOOK.md` — historical testing lessons included in the source artifact.

## Commands

Run from `worker/` with **Node.js 22+**:

```bash
npm test                       # structural recovery verifier
npm run test:restored:syntax   # parse and verify all restored test sources
npm run assets:icons           # deterministically regenerate every PWA icon
npm run test:icons             # inspect icon geometry, mask safety and SW wiring
npm run test:live:core         # fresh D1 per audit: money, WHT, workflows, sync
npm run docs:manual            # build the onboarding PDF after screenshots exist
npm run docs:onboarding        # fresh D1 → role data → desktop/mobile captures → PDF
```

`test:live:core` resets the local Wrangler D1 database before each audit. This is intentional: these tests create sales, payments, stock, transfers, and ledger entries; no result may depend on test execution order.

## Scope boundary

The historical package scripts referenced additional filenames that were not present as independently named files in the original repository artifact. The restored tests are deliberately exposed through the explicit commands above instead of claiming that every old aggregate command has been fully reconstituted. Run individual probes once their required seeded scenario is prepared with `npm run test:scenarios`.
