# Onboarding Guide Build Record

**Deliverable:** [PharmaRidge Onboarding Guide (PDF)](PharmaRidge-Onboarding-Guide.pdf)

## Delivered document

- A4 PDF, **64 pages**
- Covers Owner / Co-owner, General Manager, Branch Manager, and Counter Staff roles
- Explains onboarding, login, daily operations, POS, till, stock, procurement, transfers, safe, expenses, debtors, change owed, attendance, tax/accounting, offline work, roles, permissions, exports, pricing, and go-live steps
- Includes current screenshots from the running application, with paired desktop and phone views for role-specific screens where applicable
- Includes actual receipt, claim-slip, printable report, and CSV-export plates

## Evidence used

The guide was generated against a fresh local D1 database after:

1. applying both migrations;
2. seeding the standard demo data;
3. generating three realistic multi-branch scenarios; and
4. capturing role-driven desktop/mobile screens plus print/export artefacts.

The scenario database contained eight branches and 35 staff accounts. The figures and people in the screenshots are demo data, not real pharmacy records.

## Rebuild procedure

From `worker/`, using Node.js 22+ and the browser dependencies installed by `npm ci`:

```bash
npm run docs:onboarding
```

This command starts a fresh local D1 database, applies migrations, seeds realistic demo scenarios, captures the desktop/mobile role views and print/export artefacts, then writes the PDF. Override its default output or screenshot directory when needed:

```bash
OUT_PDF=/absolute/path/guide.pdf SHOT_DIR=/tmp/guide-shots npm run docs:onboarding
```
