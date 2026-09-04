# PharmaRidge Test Suite

Run tests from `worker/` with **Node.js 22+**. The browser, domain and
simulation runners use a fresh **local** D1 database and must never be pointed
at a production Worker or production D1 database.

## Main commands

```bash
npm test                         # parse active test sources
npm run test:data-management     # isolated Owner-only cleanup/reset audit
npm run test:data-management:consecutive-terms  # three 90-day terms per accounting/stock continuity policy
npm run test:production-readiness:capacity # simultaneous same-stock POS sales + safe plan downgrade checks
npm run test:simulation:three-months  # 90-day local operations simulation
npm run test:live:full-domain    # full local domain suite
npm run test:frontend:full       # browser/UI suite
npm run test:browser:pwa         # PWA/theme/accessibility suite
npm run test:icons               # launcher and transparent-icon checks
npm run docs:onboarding           # rebuild the customer onboarding PDF
```

`test:simulation:three-months` seeds local sample data, starts a local Worker,
creates a 90-day operating history, and validates sales, VAT, WHT, stock, till,
attendance, transfer and balanced-general-ledger outcomes. It does not make
remote API or D1 writes.

Focused browser regressions live in `test/tools/probe-*.js`; each is included
by the appropriate full runner.
