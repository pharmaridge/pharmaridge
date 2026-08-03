// General Ledger posting engine — Cloudflare D1 port of the original
// implementation's double-entry accounting core (see that file for the
// full design rationale; this mirrors it exactly, adapted only for D1's
// async, batch-based write model instead of better-sqlite3's synchronous
// db.transaction).
//
// KEY ARCHITECTURAL DIFFERENCE FROM THE NODE VERSION: this module does NOT
// execute any writes itself. Every postXxx function here is async and
// returns `{ entryId, statements }` — an array of already- bound
// `db.prepare(...).bind(...)` statement objects the CALLER must append to
// its OWN `db.batch([...])` array (alongside its other writes for the same
// business event) and execute together. This is the same "one atomic
// db.batch per business event" pattern already used everywhere else in the
// Worker deployment (see e.g. worker/src/services/salesService.js's
// createSale, which batches sales/sale_items/stock_batches/debtor_ledger
// writes as one array) — D1 has no interactive transactions, so "commit or
// roll back together" can ONLY be achieved by submitting every statement
// for one business event as a single db.batch call, never as several
// separate awaited statements.
const { uuid } = require('../lib/crypto');

let accountIdByCode = null;
async function loadAccountCache(db) {
  const { results } = await db.prepare('SELECT id, code FROM gl_accounts WHERE is_deleted = 0').all();
  accountIdByCode = new Map(results.map((r) => [r.id, r.code]).map(([id, code]) => [code, id]));
}
async function accountId(db, code) {
  if (!accountIdByCode) await loadAccountCache(db);
  let id = accountIdByCode.get(code);
  if (!id) {
    await loadAccountCache(db);
    id = accountIdByCode.get(code);
    if (!id) throw new Error(`GL posting error: no gl_accounts row found for code '${code}' — this is a system-account bootstrap bug, not a user-facing error`);
  }
  return id;
}

// Auto-creates a per-expense-category GL sub-account — see the write-up
// below's identical function for the full rationale. Unlike the Node
// version, this returns a STATEMENT to append to the caller's batch (if
// the account doesn't exist yet) rather than executing the INSERT
// directly, since this module never writes on its own (see file-header
// comment) — the caller is responsible for including this in the SAME
// batch as the rest of the posting, so the new account and the journal
// lines that reference it commit atomically together. CACHE-POISONING BUG
// FOUND AND FIXED DURING THE PRE-LAUNCH AUDIT (reproduced against a real
// SQLite database, not theorised):
//
// This function previously did `accountIdByCode.set(code, id)` for the
// NEWLY-GENERATED id at the moment it BUILT the INSERT statement — before
// that statement had been committed by the caller's db.batch. Because this
// module deliberately never writes on its own, the caller can still fail
// to commit (any constraint error elsewhere in the same batch, a
// plan-limit rollback, or the request being aborted). When that happened
// the module-level cache was left permanently asserting
// "EXPENSE_CATEGORY:diesel = <id>" for an id that does not exist in the
// database. Every subsequent expense in that category then took the
// early-return path (`statement: null` — "the account already exists"), so
// its journal lines referenced a phantom gl_accounts row and the whole
// posting died with `FOREIGN KEY constraint failed`. The failure is
// sticky: it persists for the life of the Worker isolate, so a client
// could see expense recording break for one category with no way to clear
// it other than waiting for the isolate to recycle.
//
// The fix: NEVER cache a speculative id. The pending code->id mapping is
// returned to the caller and threaded through this one posting only (see
// `overrides` in buildJournalEntryStatements). Committed rows are still
// cached normally via loadAccountCache/accountId. If the batch fails,
// nothing was cached, so the retry rebuilds the INSERT exactly as the
// first attempt did and simply succeeds.
async function ensureExpenseCategoryAccount(db, category) {
  const code = `EXPENSE_CATEGORY:${category.trim().toLowerCase()}`;
  if (accountIdByCode && accountIdByCode.has(code)) return { id: accountIdByCode.get(code), statement: null };
  const existing = await db.prepare('SELECT id FROM gl_accounts WHERE code = ? AND is_deleted = 0').bind(code).first();
  if (existing) {
    // Safe to cache: this row is committed and visible to a fresh read.
    if (accountIdByCode) accountIdByCode.set(code, existing.id);
    return { id: existing.id, statement: null };
  }
  const parentId = await accountId(db, 'OPERATING_EXPENSES');
  const id = uuid();
  const statement = db.prepare(`
    INSERT INTO gl_accounts (id, code, name, account_type, parent_id, is_system, description)
    VALUES (?,?,?,'EXPENSE',?,0,?)
  `).bind(id, code, category.trim(), parentId, `Auto-created sub-account for the "${category.trim()}" expense category.`);
  // Deliberately NOT written into accountIdByCode — see the comment
  // above. The caller threads it through as a per-posting override.
  return { id, statement, code };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Builds the DRAFT entry + lines + POSTED-transition statements for one
// balanced journal entry, returning them for the caller to append to
// its own db.batch() array — see file-header comment for why this
// module never executes writes itself. Validates the balance
// invariant BEFORE building any statements (the same first line of
// defense as the Node version), with schema.sql's
// trg_gl_journal_entry_must_balance_before_posting trigger as the
// second, database-level line of defense once the caller's batch
// actually commits.
// `accountOverrides` (optional): a plain object of { accountCode: id }
// for accounts that are being CREATED in this very same batch and are
// therefore not yet readable from the database. See
// ensureExpenseCategoryAccount() for why these must not go in the
// module-level cache.
async function buildJournalEntryStatements(db, { branchId, sourceType, sourceId, description, postedBy, lines, accountOverrides }) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error(`GL posting error: postJournalEntry for ${sourceType}/${sourceId} requires at least 2 lines, got ${lines ? lines.length : 0}`);
  }
  let totalDebits = 0;
  let totalCredits = 0;
  for (const line of lines) {
    const debit = round2(line.debit || 0);
    const credit = round2(line.credit || 0);
    if (debit > 0 && credit > 0) {
      throw new Error(`GL posting error: a single journal line cannot have both a debit and a credit (account ${line.accountCode})`);
    }
    if (debit === 0 && credit === 0) {
      throw new Error(`GL posting error: journal line for account ${line.accountCode} has neither a debit nor a credit`);
    }
    totalDebits += debit;
    totalCredits += credit;
  }
  if (Math.abs(round2(totalDebits) - round2(totalCredits)) > 0.005) {
    throw new Error(`GL posting error: entry for ${sourceType}/${sourceId} does not balance (debits=${totalDebits}, credits=${totalCredits})`);
  }

  const entryId = uuid();
  const statements = [
    db.prepare(`
      INSERT INTO gl_journal_entries (id, branch_id, source_type, source_id, description, posted_by, status)
      VALUES (?,?,?,?,?,?,'DRAFT')
    `).bind(entryId, branchId, sourceType, sourceId, description || null, postedBy || null),
  ];

  for (const line of lines) {
    const debit = round2(line.debit || 0);
    const credit = round2(line.credit || 0);
    const acctId = (accountOverrides && accountOverrides[line.accountCode])
      || await accountId(db, line.accountCode);
    statements.push(db.prepare(`
      INSERT INTO gl_journal_lines (id, journal_entry_id, account_id, debit, credit, memo)
      VALUES (?,?,?,?,?,?)
    `).bind(uuid(), entryId, acctId, debit, credit, line.memo || null));
  }

  // This UPDATE is the exact statement schema.sql's
  // trg_gl_journal_entry_must_balance_before_posting trigger fires on — see
  // the write-up below's identical comment for the full rationale. Must be
  // the LAST statement referencing this entry in the batch, so every line
  // above has already been inserted by the time D1 evaluates the trigger
  // (db.batch executes its statements in array order within one atomic
  // unit).
  statements.push(
    db.prepare(`UPDATE gl_journal_entries SET status = 'POSTED', updated_at = datetime('now') WHERE id = ?`).bind(entryId)
  );

  return { entryId, statements };
}

async function alreadyPosted(db, sourceType, sourceId) {
  const row = await db.prepare(`
    SELECT 1 FROM gl_journal_entries WHERE source_type = ? AND source_id = ? AND status = 'POSTED' AND is_deleted = 0 LIMIT 1
  `).bind(sourceType, sourceId).first();
  return !!row;
}

// ---------------------------------------------------------------------
// Per-event posting functions — see the write-up below for the full
// accounting rationale behind each (mirrored here exactly). Each returns
// `{ entryId, statements } | null` (null = event already posted, or
// nothing financially happened) — the caller appends `.statements` to its
// own batch array.
// ---------------------------------------------------------------------

async function postSale(db, { branchId, saleId, servedBy, subtotal, discount, payments, costOfGoodsSold, vatAmount = 0, whtAmount = 0 }) {
  if (await alreadyPosted(db, 'SALE', saleId)) return null;
  // VAT (Value Added Tax) — mirrors the identical fix + full design
  // rationale in the original design: vatAmount is RECLASSIFIED out of what
  // would otherwise be pure Sales Revenue into VAT_PAYABLE — the combined
  // credit still sums to exactly `subtotal`, so this never changes what the
  // customer paid or the entry's balance.
  const lines = [
    { accountCode: 'SALES_REVENUE', credit: round2(subtotal - vatAmount), memo: 'Gross sale revenue (net of VAT)' },
  ];
  if (vatAmount > 0) {
    lines.push({ accountCode: 'VAT_PAYABLE', credit: vatAmount, memo: 'VAT collected, owed to FIRS' });
  }
  if (discount > 0) {
    lines.push({ accountCode: 'SALES_DISCOUNTS', debit: discount, memo: 'Discount given on sale' });
  }
  for (const p of payments) {
    if (p.amount <= 0) continue;
    if (p.method === 'CASH') lines.push({ accountCode: 'CASH', debit: p.amount, memo: 'Cash payment received' });
    else if (p.method === 'CREDIT') lines.push({ accountCode: 'ACCOUNTS_RECEIVABLE', debit: p.amount, memo: 'Credit sale — customer owes this amount' });
    else lines.push({ accountCode: 'BANK_POS_CLEARING', debit: p.amount, memo: `${p.method} payment received (pending bank reconciliation)` });
  }
  // WITHHOLDING TAX SUFFERED ON THIS SALE (the RECEIVABLE direction).
  //
  // A corporate customer — a hospital, NGO or government buyer on contract
  // — is itself a tax agent and withholds 2% of the invoice, paying the
  // pharmacy less cash. The pharmacy's REVENUE is unchanged: it earned the
  // gross invoice value. The withheld slice is an ASSET, a prepaid
  // income-tax credit to be offset against the pharmacy's own CIT bill
  // once the customer issues a credit note:
  //
  //     DR Cash / Receivable       net
  //     DR WHT Receivable          wht      <- an asset, NOT an expense
  //       CR Sales Revenue         gross
  //
  // Treating the shortfall as a discount or a bad debt would understate
  // revenue and quietly throw away a reclaimable tax credit.
  if (whtAmount > 0) {
    lines.push({ accountCode: 'WHT_RECEIVABLE', debit: round2(whtAmount), memo: 'Withholding tax deducted by the customer — prepaid income-tax credit' });
  }
  if (costOfGoodsSold > 0) {
    lines.push({ accountCode: 'COST_OF_GOODS_SOLD', debit: costOfGoodsSold, memo: 'Cost of goods sold' });
    lines.push({ accountCode: 'INVENTORY_ASSET', credit: costOfGoodsSold, memo: 'Inventory reduced by cost of goods sold' });
  }
  return buildJournalEntryStatements(db, { branchId, sourceType: 'SALE', sourceId: saleId, description: 'Sale completed', postedBy: servedBy, lines });
}

async function postSaleVoid(db, { branchId, saleId, voidedBy }) {
  if (await alreadyPosted(db, 'SALE_VOID', saleId)) return null;
  const originalEntry = await db.prepare(`
    SELECT id FROM gl_journal_entries WHERE source_type = 'SALE' AND source_id = ? AND status = 'POSTED' AND is_deleted = 0
  `).bind(saleId).first();
  if (!originalEntry) return null;
  const { results: originalLines } = await db.prepare('SELECT account_id, debit, credit, memo FROM gl_journal_lines WHERE journal_entry_id = ?').bind(originalEntry.id).all();
  const { results: allAccounts } = await db.prepare('SELECT id, code FROM gl_accounts').all();
  const accountCodeById = new Map(allAccounts.map((r) => [r.id, r.code]));
  const lines = originalLines.map((l) => ({
    accountCode: accountCodeById.get(l.account_id),
    debit: l.credit,
    credit: l.debit,
    memo: `Reversal: ${l.memo || ''}`.trim(),
  }));
  return buildJournalEntryStatements(db, { branchId, sourceType: 'SALE_VOID', sourceId: saleId, description: 'Sale voided — reversing original entry', postedBy: voidedBy, lines });
}

// WITHHOLDING TAX AT THE POINT OF RECEIVING STOCK.
//
// The supply of goods by anyone other than the manufacturer/producer
// attracts 2% under the 2024 Regulations, and a pharmacy buying from a
// distributor is squarely in scope. Inventory is always capitalised at the
// GROSS cost — the drugs are worth what they cost, regardless of how the
// payment was split:
//
//   CASH purchase:  DR Inventory gross / CR Cash net / CR WHT Payable wht
//   CREDIT purchase: DR Inventory gross / CR Accounts Payable gross
//
// On a CREDIT purchase no WHT arises here: nothing has been paid yet, and
// WHT is deducted AT PAYMENT. Deducting at receipt as well would
// double-count it once the supplier payment is later recorded. Callers are
// prevented from doing so by the route, and this function ignores any
// whtAmount when onCredit is set rather than silently unbalancing.
async function postPoReceive(db, { branchId, poId, receivedBy, totalCost, onCredit, whtAmount = 0 }) {
  if (totalCost <= 0) return null;
  if (await alreadyPosted(db, 'PO_RECEIVE', poId)) return null;
  const wht = onCredit ? 0 : round2(whtAmount || 0);
  const lines = [
    { accountCode: 'INVENTORY_ASSET', debit: totalCost, memo: 'Stock received into inventory (gross cost)' },
  ];
  if (onCredit) {
    lines.push({ accountCode: 'ACCOUNTS_PAYABLE', credit: totalCost, memo: 'Stock received on supplier credit' });
  } else {
    lines.push({ accountCode: 'CASH', credit: round2(totalCost - wht), memo: wht > 0 ? 'Net cash paid for stock after WHT' : 'Stock paid for on receipt' });
    if (wht > 0) {
      lines.push({ accountCode: 'WHT_PAYABLE', credit: wht, memo: 'Withholding tax deducted on supply of goods, owed to the revenue authority' });
    }
  }
  return buildJournalEntryStatements(db, { branchId, sourceType: 'PO_RECEIVE', sourceId: poId, description: 'Purchase order received', postedBy: receivedBy, lines });
}

async function postCustomerPayment(db, { branchId, paymentId, recordedBy, amount, method = 'CASH' }) {
  if (await alreadyPosted(db, 'CUSTOMER_PAYMENT', paymentId)) return null;
  const inflowAccount = method === 'CASH' ? 'CASH' : 'BANK_POS_CLEARING';
  const lines = [
    { accountCode: inflowAccount, debit: amount, memo: 'Customer debt repayment received' },
    { accountCode: 'ACCOUNTS_RECEIVABLE', credit: amount, memo: 'Customer balance reduced' },
  ];
  return buildJournalEntryStatements(db, { branchId, sourceType: 'CUSTOMER_PAYMENT', sourceId: paymentId, description: 'Customer payment recorded', postedBy: recordedBy, lines });
}

// WITHHOLDING TAX ON A SUPPLIER PAYMENT.
//
// `amount` is the GROSS invoice value being settled — the figure that
// clears the supplier's account. When WHT is deducted the pharmacy hands
// over less CASH than that, and the difference becomes a debt to the
// revenue authority:
//
//     DR Accounts Payable   gross     (supplier is settled in full)
//       CR Cash                net     (only this much actually left)
//       CR WHT Payable         wht     (now owed to FIRS/NRS)
//
// The supplier's balance MUST clear by the gross figure. Clearing it by
// the net would leave a permanent phantom debt equal to every deduction
// ever made, and the supplier's own books would disagree with the
// pharmacy's — the single most common WHT bookkeeping error.
async function postSupplierPayment(db, { branchId, paymentId, recordedBy, amount, whtAmount = 0, paidByMethod = 'CASH', cashSources = null }) {
  if (await alreadyPosted(db, 'SUPPLIER_PAYMENT', paymentId)) return null;
  const wht = round2(whtAmount || 0);
  const cash = round2(amount - wht);
  // A delivery is routinely paid from the safe, not the counter — that is the
  // whole reason the safe exists. Route the credit to the pot the money
  // actually left.
  const outflowAccount = paidByMethod === 'SAFE' ? 'BRANCH_SAFE'
    : paidByMethod === 'TRANSFER' || paidByMethod === 'POS_CARD' ? 'BANK_POS_CLEARING'
      : 'CASH';
  const lines = [
    { accountCode: 'ACCOUNTS_PAYABLE', debit: amount, memo: 'Supplier balance reduced (gross)' },
  ];
  // Split across the drawer and the safe — see the identical note in
  // postExpense. Apportioned by the net, last leg absorbs the rounding.
  const splitLegs = Array.isArray(cashSources) && cashSources.length > 1
    ? cashSources.filter((x) => x && x.amount > 0) : null;
  if (splitLegs) {
    let allocated = 0;
    splitLegs.forEach((leg, i) => {
      const isLast = i === splitLegs.length - 1;
      const share = isLast ? round2(cash - allocated) : round2((leg.amount / amount) * cash);
      allocated = round2(allocated + share);
      if (share <= 0) return;
      lines.push({
        accountCode: leg.source === 'SAFE' ? 'BRANCH_SAFE' : 'CASH',
        credit: share,
        memo: leg.source === 'SAFE' ? 'Safe share of this supplier payment' : 'Drawer share of this supplier payment',
      });
    });
  } else {
    lines.push({ accountCode: outflowAccount, credit: cash, memo: wht > 0 ? 'Net paid to supplier after WHT' : 'Payment made to supplier' });
  }
  if (wht > 0) {
    lines.push({ accountCode: 'WHT_PAYABLE', credit: wht, memo: 'Withholding tax deducted at source, owed to the revenue authority' });
  }
  return buildJournalEntryStatements(db, { branchId, sourceType: 'SUPPLIER_PAYMENT', sourceId: paymentId, description: 'Supplier payment recorded', postedBy: recordedBy, lines });
}

// WITHHOLDING TAX ON AN EXPENSE.
//
// `amount` is the GROSS expense — rent of ₦100,000 is a ₦100,000 cost even
// when ₦10,000 of it goes to FIRS instead of the landlord:
//
//     DR Rent Expense       gross     (the full cost is still incurred)
//       CR Cash / Bank        net     (only this much actually left)
//       CR WHT Payable        wht     (now owed to the revenue authority)
//
// The expense is NEVER reduced by the deduction. Reducing it would
// understate costs, overstate profit, and make the P&L disagree with the
// landlord's invoice — while also losing the record of tax the pharmacy
// must remit by the 21st of the following month.
// REMITTING WITHHELD TAX TO THE REVENUE AUTHORITY.
//
// The pharmacy has been holding other people's tax since it made the
// deductions; remittance is due by the 21st of the following month. This
// discharges the liability and moves real cash out:
//
//     DR WHT Payable   amount     (the debt to FIRS/NRS is settled)
//       CR Cash / Bank  amount
//
// Without this, WHT_PAYABLE would grow forever and the Balance Sheet would
// show a liability the pharmacy had in fact already paid.
async function postWhtRemittance(db, { branchId, remittanceId, recordedBy, amount, method = 'TRANSFER' }) {
  if (await alreadyPosted(db, 'WHT_REMITTANCE', remittanceId)) return null;
  const outflowAccount = method === 'CASH' ? 'CASH' : 'BANK_POS_CLEARING';
  const lines = [
    { accountCode: 'WHT_PAYABLE', debit: amount, memo: 'Withholding tax remitted to the revenue authority' },
    { accountCode: outflowAccount, credit: amount, memo: 'Cash paid on WHT remittance' },
  ];
  return buildJournalEntryStatements(db, {
    branchId, sourceType: 'WHT_REMITTANCE', sourceId: remittanceId,
    description: 'Withholding tax remitted', postedBy: recordedBy, lines,
  });
}

async function postExpense(db, { branchId, expenseId, recordedBy, amount, category, paidByMethod, whtAmount = 0, cashSources = null }) {
  if (await alreadyPosted(db, 'EXPENSE', expenseId)) return null;
  // Three cash-bearing destinations, and a purchase may draw on TWO of them at
  // once. 'SAFE' means the branch's own reserve — a real, separate asset from
  // the counter drawer (see BRANCH_SAFE in the chart of accounts). Crediting
  // CASH for a safe payment is precisely what made the till reconcile to an
  // impossible negative figure before the safe existed (Bug 96).
  const outflowAccount = paidByMethod === 'SAFE' ? 'BRANCH_SAFE'
    : (paidByMethod === 'CASH' || !paidByMethod) ? 'CASH'
      : 'BANK_POS_CLEARING';
  const { id: categoryAccountId, statement: categoryAccountStatement } = await ensureExpenseCategoryAccount(db, category);
  const categoryCode = `EXPENSE_CATEGORY:${category.trim().toLowerCase()}`;
  const wht = round2(whtAmount || 0);
  const cash = round2(amount - wht);
  const lines = [
    { accountCode: categoryCode, debit: amount, memo: `Expense: ${category}` },
  ];
  // A SPLIT PAYMENT credits each pot for its own share. Apportioned by the net
  // (after withholding tax) because the withheld slice never leaves the branch
  // at all — it becomes a debt to the revenue authority — so neither pot should
  // be credited with it. The last leg absorbs the rounding remainder, so the
  // credits always sum to `cash` exactly and the entry cannot fail the
  // balance trigger by a kobo.
  const split = Array.isArray(cashSources) && cashSources.length > 1
    ? cashSources.filter((x) => x && x.amount > 0) : null;
  if (split) {
    let allocated = 0;
    split.forEach((leg, i) => {
      const isLast = i === split.length - 1;
      const share = isLast ? round2(cash - allocated) : round2((leg.amount / amount) * cash);
      allocated = round2(allocated + share);
      if (share <= 0) return;
      lines.push({
        accountCode: leg.source === 'SAFE' ? 'BRANCH_SAFE' : 'CASH',
        credit: share,
        memo: leg.source === 'SAFE' ? 'Safe share of this purchase' : 'Drawer share of this purchase',
      });
    });
  } else {
    lines.push({ accountCode: outflowAccount, credit: cash, memo: wht > 0 ? 'Net paid after withholding tax' : 'Expense paid' });
  }
  if (wht > 0) {
    lines.push({ accountCode: 'WHT_PAYABLE', credit: wht, memo: 'Withholding tax deducted at source, owed to the revenue authority' });
  }
  // When the category account is being created inside THIS batch it is
  // not yet readable, so pass its id through explicitly rather than
  // letting accountId() attempt a lookup that would fail (or, worse,
  // consult a speculatively-populated cache).
  const { entryId, statements } = await buildJournalEntryStatements(db, {
    branchId, sourceType: 'EXPENSE', sourceId: expenseId,
    description: `Expense recorded: ${category}`, postedBy: recordedBy, lines,
    accountOverrides: categoryAccountStatement ? { [categoryCode]: categoryAccountId } : undefined,
  });
  // The category account (if newly created) must be inserted BEFORE
  // the journal lines that reference it via foreign key — prepended
  // here rather than appended, since db.batch() executes in array
  // order and gl_journal_lines.account_id REFERENCES gl_accounts(id).
  const finalStatements = categoryAccountStatement ? [categoryAccountStatement, ...statements] : statements;
  return { entryId, statements: finalStatements, categoryAccountId };
}

async function postStockAdjustment(db, { branchId, adjustmentId, recordedBy, quantityChange, costPricePerUnit }) {
  if (await alreadyPosted(db, 'STOCK_ADJUSTMENT', adjustmentId)) return null;
  const value = round2(Math.abs(quantityChange) * costPricePerUnit);
  if (value <= 0) return null;
  const isShrinkage = quantityChange < 0;
  const lines = isShrinkage
    ? [
        { accountCode: 'INVENTORY_SHRINKAGE_EXPENSE', debit: value, memo: 'Stock written off' },
        { accountCode: 'INVENTORY_ASSET', credit: value, memo: 'Inventory reduced by write-off' },
      ]
    : [
        { accountCode: 'INVENTORY_ASSET', debit: value, memo: 'Inventory increased by correction' },
        { accountCode: 'INVENTORY_SHRINKAGE_EXPENSE', credit: value, memo: 'Correction reduces previously-recorded shrinkage' },
      ];
  return buildJournalEntryStatements(db, { branchId, sourceType: 'STOCK_ADJUSTMENT', sourceId: adjustmentId, description: 'Stock adjustment', postedBy: recordedBy, lines });
}

// An inter-branch stock transfer's completion has financial impact on TWO
// different branches at once — see the write-up below's identical
// postStockTransferOut/postStockTransferIn for the full rationale and the
// original implementation for the real bug this closes.
async function postStockTransferOut(db, { branchId, transferId, initiatedBy, value }) {
  if (await alreadyPosted(db, 'STOCK_TRANSFER_OUT', transferId)) return null;
  if (value <= 0) return null;
  const lines = [
    { accountCode: 'INTER_BRANCH_TRANSFER_CLEARING', debit: value, memo: 'Stock transferred out to another branch' },
    { accountCode: 'INVENTORY_ASSET', credit: value, memo: 'Inventory reduced by outgoing transfer' },
  ];
  return buildJournalEntryStatements(db, { branchId, sourceType: 'STOCK_TRANSFER_OUT', sourceId: transferId, description: 'Stock transfer sent to another branch', postedBy: initiatedBy, lines });
}

async function postStockTransferIn(db, { branchId, transferId, receivedBy, value }) {
  if (await alreadyPosted(db, 'STOCK_TRANSFER_IN', transferId)) return null;
  if (value <= 0) return null;
  const lines = [
    { accountCode: 'INVENTORY_ASSET', debit: value, memo: 'Inventory increased by incoming transfer' },
    { accountCode: 'INTER_BRANCH_TRANSFER_CLEARING', credit: value, memo: 'Stock transferred in from another branch' },
  ];
  return buildJournalEntryStatements(db, { branchId, sourceType: 'STOCK_TRANSFER_IN', sourceId: transferId, description: 'Stock transfer received from another branch', postedBy: receivedBy, lines });
}

// A till close's cash discrepancy is posted here so the CASH account's GL
// balance always tracks the TRUE, physically-counted amount — see the
// write-up below's identical postTillClose for the full rationale and the
// original implementation 013 for the real bug this closes.
async function postTillClose(db, { branchId, tillSessionId, closedBy, discrepancy }) {
  if (await alreadyPosted(db, 'TILL_CLOSE', tillSessionId)) return null;
  const value = round2(Math.abs(discrepancy));
  if (value <= 0) return null;
  const isShortage = discrepancy < 0;
  const lines = isShortage
    ? [
        { accountCode: 'CASH_OVER_SHORT', debit: value, memo: 'Till close cash shortage' },
        { accountCode: 'CASH', credit: value, memo: 'Cash reduced to match physically counted till total' },
      ]
    : [
        { accountCode: 'CASH', debit: value, memo: 'Cash increased to match physically counted till total' },
        { accountCode: 'CASH_OVER_SHORT', credit: value, memo: 'Till close cash overage' },
      ];
  return buildJournalEntryStatements(db, { branchId, sourceType: 'TILL_CLOSE', sourceId: tillSessionId, description: 'Till closed with a cash discrepancy', postedBy: closedBy, lines });
}

// ---------------------------------------------------------------------
// Reporting — read-only, mirrors the original implementation exactly (see
// that file for the full rationale behind each report).
// ---------------------------------------------------------------------
const DEBIT_NORMAL_TYPES = new Set(['ASSET', 'EXPENSE']);
function signedBalance(accountType, totalDebits, totalCredits) {
  return DEBIT_NORMAL_TYPES.has(accountType) ? round2(totalDebits - totalCredits) : round2(totalCredits - totalDebits);
}

async function getChartOfAccounts(db) {
  const { results } = await db.prepare(`SELECT * FROM gl_accounts WHERE is_deleted = 0 ORDER BY account_type, code`).all();
  return results;
}

async function getTrialBalance(db, branchId) {
  const { results } = branchId
    ? await db.prepare('SELECT * FROM v_gl_account_balances WHERE branch_id = ? ORDER BY account_type, account_code').bind(branchId).all()
    : await db.prepare('SELECT * FROM v_gl_account_balances_total ORDER BY account_type, account_code').all();
  return results.map((r) => ({ ...r, balance: signedBalance(r.account_type, r.total_debits, r.total_credits) }));
}

async function getProfitAndLoss(db, { branchId, startDate, endDate }) {
  const branchClause = branchId ? 'AND gje.branch_id = ?' : '';
  const params = branchId ? [startDate, endDate, branchId] : [startDate, endDate];
  const { results: rows } = await db.prepare(`
    SELECT ga.account_type, ga.code AS account_code, ga.name AS account_name,
           COALESCE(SUM(gjl.debit), 0) AS total_debits, COALESCE(SUM(gjl.credit), 0) AS total_credits
    FROM gl_journal_lines gjl
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = gjl.account_id
    WHERE gje.status = 'POSTED' AND gje.is_deleted = 0
      AND ga.account_type IN ('REVENUE', 'EXPENSE')
      -- BUG 46: bucket by the WEST AFRICA TIME calendar date, not UTC.
      -- entry_date defaults to datetime('now') = UTC, but this is a
      -- Nigeria-only product and every other daily figure in the system
      -- already shifts by +1 hour (see TODAY_WAT in routes/dashboard.js and
      -- the v_daily_sales_* views' date(created_at,'+1 hours')). The GL was
      -- the sole outlier, so money spent between 00:00 and 00:59 WAT landed
      -- in the PREVIOUS UTC day — and, at a month boundary, the previous
      -- month's profit. Live-reproduced: 50,000 rent paid 00:30 WAT on
      -- 1 July appeared in the JUNE P&L while the dashboard showed July.
      AND date(gje.entry_date, '+1 hours') >= date(?) AND date(gje.entry_date, '+1 hours') <= date(?)
      ${branchClause}
    GROUP BY ga.id
    ORDER BY ga.account_type, ga.code
  `).bind(...params).all();

  const revenueLines = [];
  const expenseLines = [];
  let totalRevenue = 0;
  let totalExpenses = 0;
  for (const r of rows) {
    const balance = signedBalance(r.account_type, r.total_debits, r.total_credits);
    if (r.account_type === 'REVENUE') {
      revenueLines.push({ account_code: r.account_code, account_name: r.account_name, amount: balance });
      totalRevenue += balance;
    } else {
      expenseLines.push({ account_code: r.account_code, account_name: r.account_name, amount: balance });
      totalExpenses += balance;
    }
  }
  return {
    start_date: startDate,
    end_date: endDate,
    revenue: revenueLines,
    total_revenue: round2(totalRevenue),
    expenses: expenseLines,
    total_expenses: round2(totalExpenses),
    net_profit: round2(totalRevenue - totalExpenses),
  };
}

async function getBalanceSheet(db, { branchId, asOfDate }) {
  const branchClause = branchId ? 'AND gje.branch_id = ?' : '';
  const placeholders = (arr) => arr.map(() => '?').join(',');

  async function balancesFor(types) {
    const params = branchId ? [...types, asOfDate, branchId] : [...types, asOfDate];
    const { results } = await db.prepare(`
      SELECT ga.id, ga.code AS account_code, ga.name AS account_name, ga.account_type,
             COALESCE(SUM(gjl.debit), 0) AS total_debits, COALESCE(SUM(gjl.credit), 0) AS total_credits
      FROM gl_journal_lines gjl
      JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = gjl.account_id
      WHERE gje.status = 'POSTED' AND gje.is_deleted = 0
        AND ga.account_type IN (${placeholders(types)})
        -- BUG 46: WAT calendar date, matching getProfitAndLoss above and
        -- the dashboard. A balance sheet "as of" a date must agree with the
        -- P&L for the period ending that date, or equity will not tie out.
        AND date(gje.entry_date, '+1 hours') <= date(?)
        ${branchClause}
      GROUP BY ga.id
      ORDER BY ga.account_type, ga.code
    `).bind(...params).all();
    return results;
  }

  const assetRows = await balancesFor(['ASSET']);
  const liabilityRows = await balancesFor(['LIABILITY']);
  const equityRows = await balancesFor(['EQUITY']);

  const toLine = (r) => ({ account_code: r.account_code, account_name: r.account_name, amount: signedBalance(r.account_type, r.total_debits, r.total_credits) });
  const assets = assetRows.map(toLine);
  const liabilities = liabilityRows.map(toLine);
  const equity = equityRows.map(toLine);

  const totalAssets = round2(assets.reduce((s, a) => s + a.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, l) => s + l.amount, 0));
  const explicitEquity = round2(equity.reduce((s, e) => s + e.amount, 0));

  const pnl = await getProfitAndLoss(db, { branchId, startDate: '1970-01-01', endDate: asOfDate });
  const equityWithEarnings = [...equity, { account_code: 'CURRENT_EARNINGS', account_name: 'Current Period Earnings (unclosed)', amount: pnl.net_profit }];
  const totalEquity = round2(explicitEquity + pnl.net_profit);

  return {
    as_of_date: asOfDate,
    assets,
    total_assets: totalAssets,
    liabilities,
    total_liabilities: totalLiabilities,
    equity: equityWithEarnings,
    total_equity: totalEquity,
    balances: Math.abs(round2(totalAssets - (totalLiabilities + totalEquity))) < 0.01,
  };
}

// --- CHANGE OWED TO CUSTOMERS (BUG 95) ----------------------------------
//
// A customer pays N500 for N400 of goods and the shop has no N100 note.
//
// The sale's own posting already debits CASH with the amount APPLIED to the
// sale (N400). The extra N100 is physically in the drawer too, so it must be
// debited to CASH as well — otherwise the drawer reconciles short by exactly
// the shortfall, which is the phantom-overage half of Bug 95. The other side
// is a LIABILITY, never income: it is a named person's money.
//
//     DR Cash                    100     (it really is in the till)
//       CR Change Owed Payable   100     (and it really is theirs)
//
// Posted as its own entry keyed to the CLAIM, not folded into the sale entry,
// so that settling it later reverses cleanly against the same source id and
// the liability can be aged and audited independently of the sale.
async function postChangeOwed(db, { branchId, claimId, recordedBy, amount }) {
  if (await alreadyPosted(db, 'CHANGE_OWED', claimId)) return null;
  const value = round2(amount);
  const lines = [
    { accountCode: 'CASH', debit: value, memo: 'Cash retained because no change was available' },
    { accountCode: 'CHANGE_OWED_PAYABLE', credit: value, memo: 'Change owed to customer' },
  ];
  return buildJournalEntryStatements(db, {
    branchId, sourceType: 'CHANGE_OWED', sourceId: claimId,
    description: 'Change owed to customer (no change available at the counter)',
    postedBy: recordedBy, lines,
  });
}

// The customer comes back and is handed their money.
//
//     DR Change Owed Payable     100     (we no longer owe it)
//       CR Cash                  100     (it left the drawer)
//
// When the change is instead APPLIED to a new purchase, the cash never moves:
// the new sale debits CASH for what the customer actually hands over, and this
// entry clears the liability against that sale's revenue instead. Passing
// `appliedToSale` switches the credit leg accordingly.
async function postChangeSettlement(db, { branchId, claimId, settledBy, amount, appliedToSale = false }) {
  if (await alreadyPosted(db, 'CHANGE_SETTLEMENT', claimId)) return null;
  const value = round2(amount);
  const lines = [
    { accountCode: 'CHANGE_OWED_PAYABLE', debit: value, memo: 'Change claim discharged' },
    appliedToSale
      // The liability is consumed as consideration for the new sale. CASH is
      // untouched: the drawer only ever saw the money once, on the original
      // sale, and it has been sitting there ever since.
      ? { accountCode: 'SALES_REVENUE', credit: value, memo: 'Owed change applied against a new purchase' }
      : { accountCode: 'CASH', credit: value, memo: 'Owed change paid out to customer' },
  ];
  return buildJournalEntryStatements(db, {
    branchId, sourceType: 'CHANGE_SETTLEMENT', sourceId: claimId,
    description: appliedToSale ? 'Owed change applied to a later purchase' : 'Owed change paid out in cash',
    postedBy: settledBy, lines,
  });
}

// The OWNER decides an unclaimed balance will never be collected.
//
//     DR Change Owed Payable     100
//       CR Other Income          100
//
// Deliberately OTHER_INCOME and not SALES_REVENUE: nothing was sold, and
// letting windfalls into revenue would flatter the gross-margin figure an
// owner uses to judge pricing. Client decision: this NEVER happens
// automatically — no age threshold, no cron. It is always a person deciding,
// with a reason, and it is reversible.
async function postChangeWriteOff(db, { branchId, claimId, writtenOffBy, amount }) {
  if (await alreadyPosted(db, 'CHANGE_WRITE_OFF', claimId)) return null;
  const value = round2(amount);
  const lines = [
    { accountCode: 'CHANGE_OWED_PAYABLE', debit: value, memo: 'Unclaimed change written off' },
    { accountCode: 'OTHER_INCOME', credit: value, memo: 'Unclaimed customer change recognised as income' },
  ];
  return buildJournalEntryStatements(db, {
    branchId, sourceType: 'CHANGE_WRITE_OFF', sourceId: claimId,
    description: 'Unclaimed customer change written off by the Owner',
    postedBy: writtenOffBy, lines,
  });
}

// --- BRANCH SAFE -------------------------------------------------------
//
// The safe is a second cash asset, distinct from CASH (the counter drawer).
// Every movement is a transfer between two real balance-sheet positions, or
// between the safe and whatever it paid for, so each posts a balanced pair.
//
//   DEPOSIT        DR Branch Safe / CR Cash        (swept up from the drawer)
//                  DR Branch Safe / CR Owner's contribution is NOT modelled —
//                  a deposit is recorded against CASH because in practice the
//                  money comes off the counter or out of a bank withdrawal
//                  that already reduced BANK_POS_CLEARING.
//   WITHDRAWAL     DR Cash / CR Branch Safe        (topping the drawer back up)
//   TILL_TRANSFER  same pair, signed by direction
//
// EXPENSE_PAID and SUPPLIER_PAID do NOT post here: the expense and supplier
// posters already write the full double entry, and they simply name
// BRANCH_SAFE as the outflow account instead of CASH. Posting again here would
// double-count the payment — the mistake this comment exists to prevent.
async function postSafeMovement(db, { branchId, movementId, recordedBy, signedAmount, memo }) {
  if (await alreadyPosted(db, 'SAFE_MOVEMENT', movementId)) return null;
  const value = round2(Math.abs(Number(signedAmount)));
  if (value === 0) return null;
  const intoSafe = Number(signedAmount) > 0;
  const lines = intoSafe
    ? [
      { accountCode: 'BRANCH_SAFE', debit: value, memo: memo || 'Cash moved into the branch safe' },
      { accountCode: 'CASH', credit: value, memo: 'Cash left the counter drawer' },
    ]
    : [
      { accountCode: 'CASH', debit: value, memo: 'Cash moved into the counter drawer' },
      { accountCode: 'BRANCH_SAFE', credit: value, memo: memo || 'Cash left the branch safe' },
    ];
  return buildJournalEntryStatements(db, {
    branchId, sourceType: 'SAFE_MOVEMENT', sourceId: movementId,
    description: intoSafe ? 'Cash deposited into the branch safe' : 'Cash withdrawn from the branch safe',
    postedBy: recordedBy, lines,
  });
}

module.exports = {
  buildJournalEntryStatements, alreadyPosted,
  postSafeMovement,
  postSale, postSaleVoid, postPoReceive, postCustomerPayment, postSupplierPayment, postExpense, postStockAdjustment, postWhtRemittance,
  postStockTransferOut, postStockTransferIn, postTillClose,
  postChangeOwed, postChangeSettlement, postChangeWriteOff,
  getChartOfAccounts, getTrialBalance, getProfitAndLoss, getBalanceSheet,
  round2, signedBalance,
};
