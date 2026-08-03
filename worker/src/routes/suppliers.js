const { Hono } = require('hono');
const { authRequired, managerOnly } = require('../lib/auth');
const { uuid } = require('../lib/crypto');
const { readJsonBody } = require('../lib/http');

const suppliers = new Hono();
suppliers.use('*', authRequired);

// BUG 72 — UI-ONLY SECURITY ON THE SUPPLIER LIST.
//
// This route carried NO role guard. `POST /` and `PUT /:id` are managerOnly and
// the creditor BALANCES are managerOnly, so the money was safe — but the list
// itself was readable by any authenticated cashier. Live-reproduced: a manager
// created "MedPlus Wholesale Ltd", and a STAFF token then read the full row
// back, complete with phone number and address.
//
// public/js/app.js hides the Suppliers nav from STAFF, which is exactly the
// shape of the problem: the restriction existed only in the frontend, and a
// hidden nav item is not access control. Anyone who opened the browser console,
// replayed the request, or used a stale bookmark got the list.
//
// This is not a rounding error in a report — it is the pharmacy's wholesaler
// relationships: who they buy from, the buyer's direct line, and where
// deliveries go. That is exactly the list a departing employee would want.
//
// AUDIT-REPORT.md already recorded the decision "STAFF reads of supplier debt /
// tax / expenses -> manager-and-above" and claimed it was applied. The DEBT
// endpoints were; this one was missed, and the claim went unverified until a
// probe read a real supplier row back as a cashier. Same class as Bug 71: a
// documented guarantee nobody had executed.
//
// WHY NOT SIMPLY managerOnly, WHICH WAS THE FIRST ATTEMPT: a cashier legitimately
// needs supplier NAMES. views/purchaseOrders.js — a screen STAFF can reach — does
//     Promise.all([ /purchase-orders, /suppliers, /products ])
// to populate the "order from" dropdown and to label received deliveries.
// Blanket-403 made that Promise.all reject and took the whole Purchase Orders
// screen down for every cashier. Verified before shipping: STAFF GET /suppliers
// -> 403 while GET /purchase-orders -> 200, i.e. the screen would half-load and
// then fail.
//
// So the fix is a PROJECTION, not a refusal. A cashier gets exactly what the
// dropdown needs — id and name — and nothing else. A manager gets the full
// record. Contact details and addresses stay manager-and-above, which is what
// the original decision was actually protecting.
suppliers.get('/', async (c) => {
  const user = c.get('user');
  const isManagerish = ['MANAGER', 'OWNER', 'ADMIN'].includes(user.role);

  // DATA-SAFETY — this previously had no limit at
  // all, unlike every comparable master-data listing endpoint in the app.
  const columns = isManagerish ? '*' : 'id, name';
  const { results } = await c.env.DB
    .prepare(`SELECT ${columns} FROM suppliers WHERE is_deleted = 0 ORDER BY name LIMIT 500`)
    .all();
  return c.json(results);
});

suppliers.post('/', managerOnly, async (c) => {
  const body = await readJsonBody(c);
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const id = uuid();
  await c.env.DB.prepare('INSERT INTO suppliers (id, name, phone, address) VALUES (?,?,?,?)').bind(id, body.name, body.phone || null, body.address || null).run();
  return c.json(await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first(), 201);
});

suppliers.put('/:id', managerOnly, async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ? AND is_deleted = 0').bind(id).first();
  if (!existing) return c.json({ error: 'Supplier not found' }, 404);
  const body = await readJsonBody(c);
  const fields = ['name', 'phone', 'address'];
  const updates = fields.filter((f) => body[f] !== undefined);
  if (updates.length) {
    await c.env.DB.prepare(`UPDATE suppliers SET ${updates.map((f) => f + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...updates.map((f) => body[f]), id).run();
  }
  return c.json(await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first());
});

module.exports = suppliers;
