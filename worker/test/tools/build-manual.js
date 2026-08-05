// Builds the PharmaRidge onboarding manual as a PDF.
//
// Written as HTML and printed through headless Chromium rather than assembled
// with a PDF library: the screenshots are large, the layout needs real
// typography and page-break control, and the same stylesheet then produces a
// readable HTML version for free.
//
// Every figure quoted in the pricing chapter is computed here, not typed, so
// the arithmetic in the document cannot drift from the arithmetic that was
// checked. Every screenshot is a real capture of the running application at
// the seeded demo data — no mock-ups.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.SHOT_DIR || '/tmp/pharmaridge-manual-shots';
const OUT_PDF = process.env.OUT_PDF || '/home/user/PharmaRidge-Onboarding-Guide.pdf';
const OUT_HTML = '/tmp/manual.html';

// ---- pricing, computed once -------------------------------------------
const PER_STAFF_DAY = 50;
const PER_BRANCH_DAY = 50;
const N = (n) => 'N' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 0 });
function plan(branches, staff) {
  const perDay = branches * PER_BRANCH_DAY + staff * PER_STAFF_DAY;
  return { branches, staff, perDay, perMonth: perDay * 30, perYear: perDay * 365 };
}
const SHAPES = [
  ['One shop, 2 staff', plan(1, 2)],
  ['Two shops, 8 staff', plan(2, 8)],
  ['Five shops, 20 staff', plan(5, 20)],
  ['Ten shops, 40 staff', plan(10, 40)],
];

// Brand assets are read from the SHIPPED application files rather than copied
// into this builder, so the guide cannot drift from the login/PWA identity.
function assetData(relativePath, label) {
  const p = path.join(__dirname, '..', '..', '..', 'public', ...relativePath);
  if (!fs.existsSync(p)) { console.log(`  MISSING ${label} at ${p}`); return ''; }
  return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
}
const brandData = assetData(['branding', 'pharmaridge-logo.png'], 'full brand logo');
const iconData = assetData(['icons', 'icon-512.png'], 'application icon');

const img = (file, { quiet = false } = {}) => {
  const p = path.join(SHOTS, file);
  // `quiet` is for the OPTIONAL phone companion: a screen captured only at
  // phone width has no companion by design, and shouting MISSING for it would
  // train the reader to ignore a warning that does matter.
  if (!fs.existsSync(p)) { if (!quiet) console.log('  MISSING ' + file); return ''; }
  const b64 = fs.readFileSync(p).toString('base64');
  return `data:image/png;base64,${b64}`;
};
// CLIENT LAYOUT INSTRUCTION: every screenshot takes a WHOLE PAGE with its
// title, and the explanation of it sits on the NEXT page.
//
// So a figure is no longer an inline block inside prose — it is a two-page
// PLATE. The first page carries the title and the image scaled to fill the
// printable area; the second carries the explanation and whatever narrative
// belonged with it. Rewriting `fig()` itself, rather than the 35 call sites,
// means every existing figure in the manual upgrades at once and no call site
// can be missed.
//
// `caption` becomes the plate's TITLE. `detail` (optional second argument) is
// the explanation page's body; when a call site does not supply one the title
// is restated as the explanation, so no plate is ever left with a blank page.
let plateNo = 0;

// ONE PAGE PER SCREEN — image AND explanation together.
//
// WHY THIS CHANGED. The previous layout gave every screenshot a page of its
// own and pushed its explanation onto the next page. Measured on the built
// PDF, that produced **69 of 117 pages more than half empty**: a 300-word
// explanation was being handed a whole sheet of A4. Printed and put in front
// of a shop owner it reads as padding, and it doubles the paper a client
// spends to print the guide.
//
// The screenshot is now capped at roughly half the text block and the
// explanation sits directly beneath it, so the reader sees the picture and the
// words describing it WITHOUT TURNING A PAGE — which is also simply better
// instruction design. `page-break-inside: avoid` keeps a plate whole, so a
// screen is never split across a fold.
//
// `caption` is the plate title. `detail` is its explanation. `extra` is an
// optional third block (a table, a note, a list) that belongs with the screen
// and would otherwise have to be exiled to a page of its own.
const fig = (file, caption, detail, extra) => {
  const src = img(file);
  if (!src) return '';
  plateNo += 1;
  const body = detail || caption;
  // CLIENT INSTRUCTION: every full screenshot is shown WITH its mobile view
  // beside it. shots-manual.js captures a phone companion for every desktop
  // capture as <name>.m.png; where one exists the plate becomes a two-column
  // figure — the desktop screen and the same screen on a phone, photographed
  // in the same session at the same moment.
  //
  // This matters commercially as much as instructionally: a large share of
  // Nigerian pharmacies run this entirely on a phone, and a manual that only
  // ever shows a laptop leaves those buyers guessing whether it will work for
  // them. Showing both, on every screen, answers that without a word of copy.
  const mobileSrc = img(file.replace(/\.png$/, '.m.png'), { quiet: true });
  const figure = mobileSrc
    ? `<div class="plate-pair">
         <figure class="pp-desk"><img src="${src}" alt="${caption} — desktop"/>
           <figcaption>On a computer</figcaption></figure>
         <figure class="pp-phone"><img src="${mobileSrc}" alt="${caption} — phone"/>
           <figcaption>The same screen on a phone</figcaption></figure>
       </div>`
    : `<div class="plate-img"><img src="${src}" alt="${caption}"/></div>`;
  return `
<section class="plate">
  <div class="plate-head">
    <div class="plate-no">Screen ${plateNo}</div>
    <h3 class="plate-title">${caption}</h3>
  </div>
  ${figure}
  <div class="plate-body">${body}</div>
  ${extra || ''}
</section>`;
};

// A full-bleed plate for the ARTEFACTS — receipts, printed reports, the CSV.
// These are portrait and detail-dense (an 80mm roll is tall and narrow), so
// they get a side-by-side treatment: the artefact at a readable size on the
// left, the explanation beside it, rather than a letterbox strip on a wide
// page with the text stranded underneath.
let artNo = 0;
const artefact = (file, caption, detail, { wide = false } = {}) => {
  const src = img(file);
  if (!src) return '';
  artNo += 1;
  return `
<section class="artefact ${wide ? 'artefact-wide' : ''}">
  <div class="art-head">
    <div class="plate-no">Sample ${artNo}</div>
    <h3 class="plate-title">${caption}</h3>
  </div>
  <div class="art-row">
    <div class="art-img"><img src="${src}" alt="${caption}"/></div>
    <div class="art-body">${detail}</div>
  </div>
</section>`;
};

const css = `
  @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "DejaVu Sans", "Segoe UI", Arial, sans-serif; color: #1c2b25;
         font-size: 10.5pt; line-height: 1.55; margin: 0; }
  h1 { font-size: 26pt; color: #0a3b2c; margin: 0 0 6pt; letter-spacing: -.4pt; }
  h2 { font-size: 17pt; color: #0a3b2c; margin: 0 0 10pt; padding-bottom: 5pt;
       border-bottom: 2.5pt solid #157a4f; letter-spacing: -.2pt; }
  h3 { font-size: 12.5pt; color: #11543c; margin: 16pt 0 5pt; }
  h4 { font-size: 11pt; color: #11543c; margin: 12pt 0 4pt; }
  p { margin: 0 0 8pt; }
  ul, ol { margin: 0 0 9pt; padding-left: 17pt; }
  li { margin-bottom: 3.5pt; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  /* Screenshots are wide and tall; letting one break across a page makes the
     figure unreadable, but forcing every one to stay whole leaves large white
     gaps when a tall image cannot fit the remaining space. Capping the height
     keeps a figure small enough to sit under the text it illustrates. */
  /* ---- SCREEN PLATES: image + explanation on ONE page ----------------
     Measured on the previous build, the two-page layout left 69 of 117 pages
     more than half empty. The screenshot is capped so that it plus its
     explanation fit a single sheet, and the pair is kept together. */
  .plate { page-break-inside: avoid; margin: 0 0 11pt; }
  .plate-head { margin-bottom: 5pt; }
  .plate-no { font-size: 8.5pt; letter-spacing: .8pt; text-transform: uppercase;
              color: #6b7d75; margin-bottom: 3pt; }
  .plate-title { font-size: 13pt; color: #0a3b2c; margin: 0 0 6pt; line-height: 1.35;
                 border-bottom: 1.5pt solid #157a4f; padding-bottom: 4pt; }
  .plate-img { text-align: center; margin-bottom: 8pt; }
  /* DESKTOP + PHONE, SIDE BY SIDE.
     The phone column is fixed and narrow so the desktop screen keeps the
     width it needs to stay legible; a 50/50 split would shrink the screen
     that carries most of the detail in order to enlarge one that carries
     little. align-items:flex-start keeps both captions on the same baseline
     regardless of the two images' differing heights. */
  .plate-pair { display: flex; gap: 9pt; align-items: flex-start; margin-bottom: 8pt; }
  .plate-pair figure { margin: 0; }
  .plate-pair .pp-desk { flex: 1 1 auto; min-width: 0; }
  .plate-pair .pp-phone { flex: 0 0 34mm; }
  .plate-pair img { width: 100%; height: auto; object-fit: contain;
                    border: 1pt solid #cfdad4; border-radius: 3pt; display: block; }
  .plate-pair .pp-desk img { max-height: 96mm; object-position: top; }
  .plate-pair .pp-phone img { max-height: 96mm; object-position: top; }
  .plate-pair figcaption { font-size: 7.5pt; color: #6b7d75; margin-top: 3pt;
                           text-align: center; font-style: normal; }
  /* 118mm is a little under half the 245mm text block, which leaves room for
     roughly 350 words of explanation beneath it on the same page. */
  .plate-img img { max-width: 100%; max-height: 92mm; width: auto; height: auto;
                   object-fit: contain; border: 1pt solid #cfdad4; border-radius: 3pt; }
  .plate-body { font-size: 10pt; line-height: 1.6; }
  .plate-body p:first-child { margin-top: 0; }
  .plate-body ul { margin-top: 5pt; }

  /* ORPHAN CONTROL. Measured on the build: the pages that remained more than
     half empty were not plates at all — they were the last few bullets of a
     chapter, pushed onto a fresh sheet because the next element could not fit
     above them. Keeping a heading with what follows it, forbidding a lone
     first/last line, and letting a long list break across a page removes the
     spill without touching any wording. */
  h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
  p, li { orphans: 3; widows: 3; }
  ul, ol { page-break-inside: auto; }

  /* ---- ARTEFACT PLATES: receipts, printed reports, CSV ---------------- */
  .artefact { page-break-inside: avoid; margin: 0 0 14pt; }
  .art-head { margin-bottom: 6pt; }
  .art-row { display: flex; gap: 12pt; align-items: flex-start; }
  .art-img { flex: 0 0 62mm; }
  .art-img img { width: 100%; border: 1pt solid #cfdad4; border-radius: 3pt; }
  .art-body { flex: 1 1 auto; font-size: 9.8pt; line-height: 1.6; }
  .art-body p:first-child { margin-top: 0; }
  /* A wide artefact (A4 receipt, printed report, spreadsheet) reads better
     stacked: the detail is horizontal, so squeezing it into 62mm would make
     the type unreadable. */
  .artefact-wide .art-row { display: block; }
  .artefact-wide .art-img { width: 100%; margin-bottom: 8pt; }
  .artefact-wide .art-img img { max-height: 104mm; object-fit: contain; display: block;
                                margin: 0 auto; width: auto; max-width: 100%; }

  figure { margin: 9pt 0 11pt; page-break-inside: avoid; }
  figure img { width: 100%; max-height: 118mm; object-fit: contain; object-position: top;
               border: 1pt solid #cfdad4; border-radius: 3pt; display: block; }
  figcaption { font-size: 8.5pt; color: #5b6b64; margin-top: 4pt; font-style: italic; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 9.5pt;
          page-break-inside: avoid; }
  th { background: #0a3b2c; color: #fff; text-align: left; padding: 5pt 7pt; font-size: 9pt;
       font-weight: 600; }
  td { padding: 5pt 7pt; border-bottom: .6pt solid #dde5e1; vertical-align: top; }
  tr:nth-child(even) td { background: #f5f9f7; }
  .yes { color: #157a4f; font-weight: 700; }
  .no  { color: #b3261e; font-weight: 700; }
  .note { background: #f0f7f3; border-left: 3pt solid #157a4f; padding: 8pt 11pt; margin: 10pt 0;
          page-break-inside: avoid; }
  .warn { background: #fdf6ec; border-left: 3pt solid #c77700; padding: 8pt 11pt; margin: 10pt 0;
          page-break-inside: avoid; }
  .cover { text-align: center; padding-top: 38mm; }
  /* The transparent brand lockup is reproduced at its natural wide proportion
     with no frame or background added around it. */
  .cover-mark { width: 108mm; max-width: 90%; height: auto; max-height: 52mm;
                object-fit: contain; display: block; margin: 0 auto 12mm; }
  .mark-inline { width: 13mm; height: 13mm; vertical-align: middle;
                 object-fit: contain; margin-right: 4mm; }

  .cover .sub { font-size: 13pt; color: #3c554b; margin-top: 8pt; }
  .cover .meta { margin-top: 40mm; font-size: 9.5pt; color: #6b7d75; }
  .lead { font-size: 11.5pt; color: #3c554b; margin-bottom: 14pt; }
  .kpi { display: flex; gap: 8pt; margin: 10pt 0; }
  .kpi div { flex: 1; border: 1pt solid #cfdad4; border-radius: 3pt; padding: 7pt 9pt; }
  .kpi .k { font-size: 8pt; color: #5b6b64; text-transform: uppercase; letter-spacing: .4pt; }
  .kpi .v { font-size: 14pt; font-weight: 700; color: #0a3b2c; }
  code { background: #eef3f0; padding: 1pt 4pt; border-radius: 2pt; font-size: 9pt; }
  .toc li { margin-bottom: 5pt; }
  .role-chip { display: inline-block; background: #157a4f; color: #fff; font-size: 8.5pt;
               padding: 2pt 8pt; border-radius: 9pt; margin-bottom: 8pt; }
`;

const permissionTable = (rows) => `
<table>
  <thead><tr><th style="width:44%">What they can do</th><th>Owner</th><th>General&nbsp;Mgr</th><th>Branch&nbsp;Mgr</th><th>Staff</th></tr></thead>
  <tbody>${rows.map(([what, o, g, b, s]) => `<tr><td>${what}</td>
    <td class="${o === 'Yes' ? 'yes' : o === 'No' ? 'no' : ''}">${o}</td>
    <td class="${g === 'Yes' ? 'yes' : g === 'No' ? 'no' : ''}">${g}</td>
    <td class="${b === 'Yes' ? 'yes' : b === 'No' ? 'no' : ''}">${b}</td>
    <td class="${s === 'Yes' ? 'yes' : s === 'No' ? 'no' : ''}">${s}</td></tr>`).join('')}
  </tbody>
</table>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>PharmaRidge Onboarding Guide</title><style>${css}</style></head><body>

<!-- ============ COVER ============ -->
<section class="page cover">
  <img class="cover-mark" src="${brandData}" alt="PharmaRidge" />
  <h1>PharmaRidge</h1>
  <div class="sub">Pharmacy &amp; PPMV Management — Onboarding Guide</div>
  <div class="sub" style="font-size:11pt;margin-top:22pt;">
    For proprietors, general managers, branch managers and counter staff
  </div>
  <div class="meta">
    Every screen in this guide is a photograph of the working system,<br/>
    not a drawing. Figures shown are from a demonstration pharmacy.
  </div>
</section>

<!-- ============ CONTENTS ============ -->
<section class="page">
  <h2>What is in this guide</h2>
  <ol class="toc">
    <li><b>Why PharmaRidge exists</b> — the problems it removes from your day</li>
    <li><b>Getting in</b> — signing in, and what you see first</li>
    <li><b>Chapter for the Owner</b> — the proprietor's view and powers</li>
    <li><b>Chapter for the Co-Owner</b> — a second proprietor, and what changes</li>
    <li><b>Chapter for the General Manager</b> — running every shop</li>
    <li><b>Chapter for the Branch Manager</b> — running one shop</li>
    <li><b>Chapter for Counter Staff</b> — selling, the till, attendance</li>
    <li><b>Money that is not in the till</b> — the branch safe</li>
    <li><b>When you have no change</b> — the "no N100 note" problem, solved</li>
    <li><b>Who can do what</b> — the complete permission tables</li>
    <li><b>What it costs, and what it saves</b></li>
    <li><b>How PharmaRidge differs</b> from the software you have seen before</li>
  </ol>
  <div class="note">
    <b>A note on money.</b> PharmaRidge writes amounts as <code>N1,500.00</code> rather than with the
    naira symbol (₦). This is deliberate: the naira sign does not print on many thermal receipt printers and
    older Android phones, and a receipt that shows a box instead of a currency sign is worse than
    plain letters.
  </div>
</section>

<!-- ============ 1. WHY ============ -->
<section class="page">
  <h2>1. Why PharmaRidge exists</h2>
  <p class="lead">Most pharmacy software is a cash register with reports bolted on. PharmaRidge is
  built around the things that actually cost a Nigerian pharmacy money.</p>

  <h3>The five leaks</h3>
  <table>
    <thead><tr><th style="width:30%">The leak</th><th>What PharmaRidge does about it</th></tr></thead>
    <tbody>
      <tr><td><b>Expired stock</b></td><td>Every batch carries its expiry. Sales always draw from the
        nearest-expiry batch first, so old stock leaves before new. The dashboard counts what expires
        within 90 days, per branch, before it becomes a write-off.</td></tr>
      <tr><td><b>The drawer never balances</b></td><td>Expected cash is computed from the opening float,
        cash sales, cash expenses, debtor repayments and supplier payments — so a discrepancy means
        something real, not an arithmetic gap.</td></tr>
      <tr><td><b>Credit given and forgotten</b></td><td>Every customer has a credit limit, zero by
        default. A cashier cannot quietly extend credit; a manager must set the limit or authorise the
        override, with a reason kept forever.</td></tr>
      <tr><td><b>Change you could not give</b></td><td>Recorded against the customer's name with a
        7-digit claim code, so it is a debt the shop owes — not something that lives in a cashier's
        memory. See chapter 9.</td></tr>
      <tr><td><b>Cash bought things nobody recorded properly</b></td><td>A purchase funded partly from
        the drawer and partly from the safe is recorded as exactly that, so neither pot is misstated
        and neither comes up short at close of day.</td></tr>
      <tr><td><b>Nobody knows who did what</b></td><td>Every sale, void, price change, stock write-off,
        transfer and safe movement names the person and the time. Voids and write-offs require a
        written reason.</td></tr>
    </tbody>
  </table>

  <h3>Built for how Nigerian shops actually work</h3>
  <ul>
    <li><b>It keeps working when the network does not.</b> Sales made offline are queued on the device
      and sent when the connection returns. A cashier is never stopped by MTN.</li>
    <li><b>It runs on the phone in your pocket.</b> Every screen works from 320px upward — the
      narrowest phone still in daily use — as well as on a tablet or a laptop.</li>
    <li><b>It understands PPMV and pharmacy licensing.</b> Each branch records its PCN or PPMV
      licence and its expiry, and the dashboard warns you before renewal is due.</li>
    <li><b>It knows about controlled drugs.</b> Prescription-only and controlled items refuse to sell
      without the prescriber or buyer details a PCN inspector will ask for.</li>
    <li><b>Withholding tax is handled properly</b> — both the tax you deduct from a landlord or
      consultant, and the tax a hospital customer deducts from you.</li>
  </ul>
</section>

<!-- ============ OWNER DECISION / VERIFIED VALUE ============ -->
<section class="page">
  <span class="role-chip">Owner decision guide</span>
  <h2>Before you commit: what has been proven</h2>
  <p class="lead">A proprietor should pay for a system because it is useful and evidenced, not because a sales page makes a promise. This sample is deliberately set up so you can test the important flows yourself.</p>
  <div class="note">
    <b>Live audit evidence.</b> The current release completed a fresh-data, end-to-end audit across sales, VAT/WHT, debtors, suppliers, change owed, till and safe movements, stock receiving, transfers, user promotion/demotion, one-device sessions, role boundaries, forms, dropdowns, responsive layouts and PWA behaviour. A separate 90-day operating simulation verified dated sales, VAT/WHT, creditor/debtor, attendance, stock and transfer history. The final passing run exercised <b>3,207 checks</b> across API, database, browser and PWA surfaces.
  </div>
  <h3>What each person can prove in a demonstration</h3>
  <table>
    <thead><tr><th style="width:24%">Account</th><th>Start here</th><th>What you should see happen</th></tr></thead>
    <tbody>
      <tr><td><b>Admin</b></td><td>Create the first Owner account</td><td>The sample starts with Admin only. This proves that the vendor/admin seat can onboard a client without being able to become a cashier or move the client’s cash.</td></tr>
      <tr><td><b>Owner</b></td><td>Create a branch, manager and staff account</td><td>See the new people and branch appear immediately; set permissions, tax choices and credit limits; then receive a product from the NAFDAC catalogue into real stock.</td></tr>
      <tr><td><b>Manager</b></td><td>Open a till, receive stock, approve an expense or transfer stock</td><td>See exactly their permitted branch scope. A Branch Manager cannot read or write another branch; a General Manager can operate across the estate.</td></tr>
      <tr><td><b>Staff</b></td><td>Open their till and complete a sale</td><td>See FEFO stock selection, receipt creation, bounded void/write-off authority and a ledger/till trail that names the acting person.</td></tr>
    </tbody>
  </table>
  <h3>What your upfront decision buys you</h3>
  <ul>
    <li><b>A complete operational record from day one:</b> sales, stock, cash, customers, supplier debt, attendance and compliance records reconcile to the same source events.</li>
    <li><b>Controls that keep working on the busy day:</b> one active device per account, branch-scoped authority, idempotent offline retries, physical cash floors and double-entry balance checks.</li>
    <li><b>Evidence you can take to a partner or accountant:</b> printable reports, CSV exports, Trial Balance, Profit &amp; Loss, Balance Sheet, audit trails and the full NAFDAC-derived product set.</li>
    <li><b>A system you have tested yourself:</b> use the live sample to create an Owner, set up a branch and take stock before deciding. Do not place real client data in the shared sample.</li>
  </ul>
  <h3>A practical acceptance sequence before payment</h3>
  <ol>
    <li><b>Owner:</b> create a test branch, set your VAT/WHT and permission choices, receive a product, and read the dashboard and books.</li>
    <li><b>Managers:</b> test a delivery, safe/till movement, supplier payment, stock transfer, attendance review and staff reassignment.</li>
    <li><b>Counter staff:</b> complete a cash sale, credit sale, receipt, change-owed claim, till close and phone POS flow.</li>
    <li><b>Your actual equipment:</b> check the PWA, printer and network behaviour on the device you will use at the counter.</li>
    <li><b>Your agreement:</b> confirm deployment scope, data ownership/export, onboarding, support contacts and commercial terms in writing before payment.</li>
  </ol>
  <div class="warn">
    <b>Make the decision transparently.</b> Before paying upfront, confirm that the demonstrated roles, stock workflow, printer/PWA behaviour and support arrangements fit your own pharmacy. A real client deployment must use its own database, secure credentials, custom branding and reviewed regulatory settings — never this shared sample.
  </div>
</section>

<!-- ============ 2. GETTING IN ============ -->
<section class="page">
  <h2>2. Getting in</h2>
  <p>Everybody signs in the same way: a username and a PIN. There is no email, no password reset
  email, and nothing to remember beyond four digits — because the person signing in is often standing
  at a counter with a queue in front of them.</p>
  ${fig('00-login-desktop.png', 'The sign-in screen on a laptop', `<p>This is the only way into PharmaRidge, and it is the same for everybody from the
proprietor to the newest cashier: a <b>username</b> and a <b>PIN</b>.</p>
<p>There is no email address, no password-reset link and nothing to remember beyond four digits. That is
deliberate — the person signing in is often standing at a counter with a queue in front of them, on a
phone, possibly with no data connection.</p>
<p>Credentials are issued per person and are deliberately <b>not printed in this guide</b>. Before live trade, the Owner should issue every person a unique PIN and confirm the correct role and branch on the Users screen.</p>`)}
  <div class="note">
    <b>Shared live-sample access.</b> Demonstration access is issued separately by PharmaRidge; access
    details are deliberately not printed in this guide. The sample is resettable and
    exists only to demonstrate the Admin → Owner → branch → staff → receiving-stock sequence. Never
    enter real patient, customer, staff, supplier, or financial data into a shared sample.
  </div>
  <div class="warn">
    <b>Before you open for live trade.</b> The Owner should issue a unique PIN to every real person,
    verify their role and branch assignment, and remove or deactivate any provisional demonstration
    account. Use <b>Users → Edit → Reset PIN</b>; never share one credential across a counter team.
  </div>
  <h3>What happens after you sign in</h3>
  <p>PharmaRidge shows you the screen that matches your job. A cashier lands on the Point of Sale. A
  manager or owner lands on the dashboard. The menu on the left only ever lists what your role is
  allowed to open — you will not find a screen that refuses you when you tap it.</p>
</section>

<!-- ============ 3. OWNER ============ -->
<section class="page">
  <span class="role-chip">Chapter for the OWNER</span>
  <h2>3. The Owner</h2>
  <p class="lead">You own the pharmacy. You see everything, in every branch, and there are things only
  you can change.</p>
  ${fig('10-owner-dashboard.png', 'The Owner dashboard: takings, stock value, expiring batches, debtors, creditors, licence renewals and attendance — for every branch at once', `<p>The proprietor's view of the whole business, every branch at once.</p>
<ul>
<li><b>Sales today</b> and the transaction count — an unusually quiet counter is visible immediately.</li>
<li><b>Stock value at cost</b> and <b>at retail</b> — the gap between them is the profit sitting on your shelves.</li>
<li><b>Expiring within 90 days</b> — the money you are about to lose if nobody acts on it.</li>
<li><b>Owed by customers</b> and <b>owed to suppliers</b>, kept separate and never netted against each other.</li>
<li><b>Change we owe customers</b> — cash in your till that belongs to somebody else.</li>
<li><b>Licence renewals due</b> — PCN and superintendent registration, before they lapse.</li>
</ul>
<p>Use the branch selector at the top to drill into a single shop, or leave it on <i>All Branches</i> for the
consolidated picture.</p>`)}
  <h3>What the dashboard is telling you</h3>
  <ul>
    <li><b>Sales today</b> and the number of transactions, so an unusually quiet counter is visible immediately.</li>
    <li><b>Stock value at cost and at retail</b> — the difference is the profit sitting on your shelves.</li>
    <li><b>Expiring within 90 days</b> — the money you are about to lose if nobody acts.</li>
    <li><b>Owed by customers</b> and <b>owed to suppliers</b> — both directions, never netted.</li>
    <li><b>Change we owe customers</b> — cash sitting in your till that belongs to somebody else.</li>
    <li><b>Licence renewals due</b> — PCN and superintendent registration, before they lapse.</li>
  </ul>

  <h3>Things only the Owner can do</h3>
  <p>These are deliberately locked to you. A manager cannot do them, and cannot give themselves
  permission to.</p>
  <ul>
    <li><b>Turn VAT on or off, and set the rate.</b></li>
    <li><b>Edit the withholding-tax rates.</b> The 2024 schedule ships correct, but the rates are
      yours to adjust if the law changes.</li>
    <li><b>Decide what managers may do</b> — void sales, approve expenses, change prices — each an
      independent switch.</li>
    <li><b>Decide what cashiers may do</b> — whether they can void their own sale, within how many
      minutes, and how much stock they may write off without a manager.</li>
    <li><b>Write off change the shop owes</b> a customer who never came back.</li>
    <li><b>Review and, only when appropriate, remove data</b> through the guarded Owner Data Management process described below. A General Manager can see capacity warnings but cannot erase records.</li>
  </ul>
  ${fig('11-owner-plan.png', 'My Plan: your subscription, how many branches and staff you are using, and the switches that belong to you', `<p>What you are paying for, and what you are actually using.</p>
<p>The two bars show branches and staff against your contracted limits. They show operational use and room to grow; they do not replace the commercial terms you agree before payment. Confirm your plan price, renewal timing, included support and any cancellation/refund terms in writing. PharmaRidge's own support account is never counted as a pharmacy staff seat.</p>
<p>Further down this screen are the switches that belong to you alone — VAT, withholding-tax rates, and what
managers and cashiers are permitted to do without asking you.</p>`)}
  ${fig('11a-owner-data-management.png', 'Owner Data Management: preview first, then make a deliberate retention decision', `<p><b>This is not an everyday housekeeping button.</b> It is the Owner’s controlled route for a genuine retention or capacity decision. The system estimates active database use, warns the Owner and General Manager at 75%, and calls the situation critical at 90% of the configured database reference ceiling.</p>
<p>Use it in this exact order:</p>
<ol>
<li>Make sure every active device has synchronised. A reported offline queue, open till, open stocktake, open attendance shift, pending stock/staff transfer blocks the action.</li>
<li>Export or verify the reports and backup your business must retain. Financial, VAT/WHT, prescription and controlled-drug records may have retention obligations; ask your accountant, tax adviser or relevant regulator where needed.</li>
<li>Choose the scope and select <b>Preview impact</b>. You see current matching row counts before anything changes.</li>
<li>Tick both acknowledgements and type the displayed phrase exactly. The server repeats the role, range, active-operation and confirmation checks; changing a browser field cannot bypass them.</li>
</ol>
<p>There are three choices: remove a selected dated period while keeping current master setup; clear all business data while keeping branches and existing credentials; or perform a full business-and-team reset that also removes Manager and Staff credentials, devices and branches. A full reset still preserves the Owner account, support/admin seat, plan/tax setup, system accounts, NAFDAC reference catalogue and a minimal cleanup log so the business is never locked out.</p>
<p>Old offline requests are quarantined for review after a cleanup instead of silently recreating removed records. Deletion reduces active rows, but Cloudflare controls physical allocation; it is not a promise of an immediate storage/billing reduction. Plan capacity early as well as retaining records correctly.</p>`)}
  <h3>Your books, kept as you trade</h3>
  <p>Every sale, delivery, expense, write-off and payment posts a double entry as it happens. There is
  no month-end bookkeeping exercise: the trial balance, profit and loss, and balance sheet are correct
  at every moment.</p>
  ${fig('12-owner-accounting.png', 'Accounting: trial balance, profit and loss, balance sheet and the withholding-tax register', `<p>Your books, kept as you trade rather than written up at month end.</p>
<p>Every sale, delivery, expense, write-off, transfer and payment posts a balanced double entry the moment it
happens. The trial balance, profit and loss and balance sheet on this screen are therefore correct at every
moment — there is no closing exercise to run and nothing to reconcile by hand.</p>
<p>The withholding-tax register is here too, in both directions: tax you have deducted from a landlord or
consultant and owe the authority, and tax a hospital customer has deducted from you and which you can
reclaim.</p>`)}
</section>

<section class="page">
  <h3>People</h3>
  <p>Hire, promote, move and retire staff from one screen. When somebody changes branch or role, use
  <b>Transfer &amp; Promote</b> rather than creating a second account — one person keeps one account,
  and their history stays attached to the branch where it happened.</p>
  ${fig('13-owner-users.png', 'Users &amp; Branches: everyone who can sign in, their role, their branch and their status', `<p>Everyone who can sign in, what they are allowed to do, and which branch they belong to.</p>
<p>The red banner at the top lists any account still using the demonstration PIN. It will not go away until
every one has been changed, because an account on a default PIN is an account anybody can use.</p>
<p><b>Roles in one line:</b> an <b>Owner</b> sees everything and controls tax and permissions. A <b>General
Manager</b> runs every branch. A <b>Branch Manager</b> runs exactly one. <b>Staff</b> serve customers at one
branch.</p>`)}
  ${fig('14-owner-transfer-modal.png', 'Transfer &amp; Promote: a move is recorded with a reason and a date, never by inventing a second account', `<p>When somebody changes branch or is promoted, use <b>Transfer &amp; Promote</b> — never
create a second account for the same person.</p>
<p>PharmaRidge asks for a reason and records the date, so the change is auditable. The person keeps <b>one
account</b>, which matters more than it sounds: attendance and payroll are grouped by person, so a second
account would count one employee as two and split their sales history in half.</p>
<p>Their past sales, shifts and tills stay attached to the branch where they actually happened. The transfer
record is what shows when the change took effect.</p>`)}
  <div class="note">
    <b>Why one account matters.</b> If you create a second account for the same person, attendance and
    payroll count them as two employees, and their sales history splits in half. PharmaRidge refuses
    the shortcut and gives you the correct tool instead.
  </div>
</section>

<section class="page">
  <h3>Money owed to you</h3>
  ${fig('15-owner-customers-aging.png', 'Debtors, and how old each debt is — a balance owed since last week is trading; the same figure owed since March is not', `<p>Who owes you money, and — more importantly — <b>how long they have owed it</b>.</p>
<p>The four buckets at the top split the total by age: 0–30 days, 31–60, 61–90, and over 90. A balance owed
since last week is ordinary trading. The same figure owed since March usually is not, and it is the second
one that quietly becomes a bad debt.</p>
<p>Every customer has a credit limit, and it is <b>zero by default</b> — new customers are cash-only until
somebody with authority decides otherwise.</p>`)}
  <h3>Money going out</h3>
  ${fig('16-owner-expenses.png', 'Expenses, showing which pot paid: the till drawer, the branch safe, or the bank', `<p>Every cost the pharmacy has recorded, and &mdash; in the <i>Paid via</i> column &mdash; <b>which
pot of money paid for it</b>: the till drawer, the branch safe, or the bank.</p>
<p>That column matters because the two cash pots reconcile separately. A payment recorded against the
wrong one will show up later as a discrepancy in a drawer that was actually counted correctly, and
you will spend an evening looking for money that was never missing.</p>
<p>A single expense can be <b>split across two pots</b> &mdash; part drawer, part safe &mdash; which
is what actually happens when a delivery costs more than the till holds. Each part is charged where
it came from, so both reconciliations stay true.</p>
<p>Recording an expense is deliberately open to cashiers: the person sent out for diesel is usually
the person at the counter. What a cashier cannot do is <i>browse</i> the pharmacy's other costs
&mdash; the rent, the salaries, what another branch spends. Writing a cost down and reading everyone
else's are two different powers.</p>
<p>Where a supplier or landlord requires withholding tax, enter the rate and PharmaRidge records the
net paid and the tax withheld separately, so the WHT register is built as you trade rather than
reconstructed at year end.</p>`)}
  <h3>The screen at night</h3>
  ${fig('17-owner-dashboard-dark.png', 'Dark mode — for a dim shop at 6am, or a proprietor checking takings in bed', `<p>The same dashboard in dark mode.</p>
<p>This is not decoration. A pharmacy opening at 6am, a night shift, or a proprietor checking the
day's takings in bed all involve looking at a bright screen in a dark room. The toggle sits in the
top bar and the choice is remembered per device, so the shop laptop and your own phone can differ.</p>
<p>Every colour in the application carries a meaning rather than a fixed value &mdash; money in,
money out, something needs attention &mdash; and both themes answer with their own shade. That is
why the dark theme is not simply an inverted screenshot: warnings stay amber and legible, positive
figures stay green, and no panel ends up as white text on a white chip.</p>
<p><b>Printing always uses the light theme</b>, whichever mode you are working in. A receipt printed
from dark mode would otherwise come out as a solid block of ink &mdash; and on an 80mm thermal roll
that is a wasted roll per sale before anybody notices.</p>`)}
</section>

<section class="page">
  <h3>The pharmacy in your pocket</h3>
  <p>Everything above works on a phone. Nothing is removed; wide tables scroll sideways with a swipe.</p>
  ${fig('19-owner-menu-phone.png', 'The menu slides in over the page', `<p>On a phone the menu slides in over the page when you tap the button at the top left, and slides
away again as soon as you choose something or tap outside it.</p>
<p>It lists only the screens your role can actually open, so you will never tap something that then
refuses you. A cashier's menu is genuinely short; an owner's is long and grouped &mdash; Daily Work,
Stock, Money &amp; People, Setup &mdash; because eighteen destinations in one flat list is a list
nobody reads.</p>
<p>The screen you are on is highlighted, so after an interruption you can see where you were without
guessing. Every entry carries a drawn icon rather than an emoji: many budget Android builds ship
without an emoji font and would render a row of empty boxes.</p>`)}
</section>

<!-- ============ 4. CO-OWNER ============ -->
<section class="page">
  <span class="role-chip">Chapter for the CO-OWNER</span>
  <h2>4. The Co-Owner</h2>
  <p class="lead">A second proprietor is simply a second Owner account. Everything in chapter 3 applies
  to them exactly as it applies to you.</p>
  <h3>What is the same</h3>
  <ul>
    <li>Both owners see every branch, every figure and every report.</li>
    <li>Both can set VAT, withholding-tax rates, and the manager and cashier permission switches.</li>
    <li>Both can hire, promote, transfer and retire anybody.</li>
  </ul>
  <h3>What changes when there are two of you</h3>
  <ul>
    <li><b>Every action still names the person who took it.</b> "The Owner voided it" is never the
      answer — the record says which owner, and when.</li>
    <li><b>Either owner can recover the other.</b> If one owner is locked out by mistyped PINs, the
      other clears it instantly. With a single owner, only PharmaRidge support can.</li>
    <li><b>Neither can remove the last one.</b> PharmaRidge refuses to deactivate or delete an Owner
      account if it is the only active one left, because a pharmacy with no Owner cannot change its own
      tax settings or permissions — and no manager can restore one.</li>
  </ul>
  <div class="note">
    <b>Recommended.</b> If the business has two proprietors, create both as Owner accounts on day one.
    It costs the same, and it removes the single most awkward support call there is.
  </div>
  <h3>Dividing responsibility without dividing access</h3>
  <p>Some partnerships prefer one owner on the money and the other on operations. PharmaRidge does not
  force that split, but it makes it visible: the withholding-tax register, the void report and the
  safe ledger all name the acting person, so an agreed division of labour is auditable without
  restricting either partner's access.</p>
</section>

<!-- ============ 5. GENERAL MANAGER ============ -->
<section class="page">
  <span class="role-chip">Chapter for the GENERAL MANAGER</span>
  <h2>5. The General Manager</h2>
  <p class="lead">You run every shop, day to day, on the proprietor's behalf. You see what the Owner
  sees — except the things that belong to ownership.</p>
  ${fig('20-gm-dashboard.png', 'A General Manager sees and runs every branch', `<p>A General Manager runs every shop on the proprietor's behalf, and sees what the Owner
sees.</p>
<p>The difference is authority over the business itself rather than its operations: a General Manager cannot
change VAT or withholding-tax rates, cannot alter what managers and cashiers are permitted to do, cannot
touch the subscription, and cannot remove business data. They do receive the organisation-wide storage warning so they can alert the Owner early. Everything operational — stock, staff, pricing, transfers and cash — is theirs.</p>`)}
  <h3>What you can do everywhere</h3>
  <ul>
    <li>Open branches, hire staff, and move people between shops.</li>
    <li>Order stock, receive deliveries, and move stock between branches.</li>
    <li>Set prices, run stocktakes, and write off damaged or expired stock.</li>
    <li>Void a sale, approve an expense, and settle supplier accounts.</li>
    <li>Move money in and out of any branch's safe.</li>
  </ul>
  <h3>What you cannot do</h3>
  <ul>
    <li>Change VAT or withholding-tax rates.</li>
    <li>Change what managers or cashiers are permitted to do — those switches are the Owner's.</li>
    <li>Write off change owed to a customer.</li>
    <li>Alter the subscription, the branch cap or the staff cap.</li>
  </ul>
  ${fig('21-gm-stock.png', 'Stock across every branch, with expiry warnings', `<p>Every batch in every branch, with its expiry date.</p>
<p>PharmaRidge tracks stock at <b>batch</b> level, not just product level, which is what makes two things
possible: an expiry warning that is actually accurate, and traceability if a batch is ever recalled.</p>
<p>Sales always draw from the <b>nearest-expiry batch first</b>, automatically. Nobody at the counter has to
think about it, and old stock leaves before new.</p>`)}
</section>

<section class="page">
  <h3>Moving stock where it sells</h3>
  <p>A slow-moving pack at one shop is often a fast seller at another. A transfer keeps the batch
  number and expiry date intact, so traceability survives the move, and the receiving branch must
  confirm arrival before the stock becomes sellable there.</p>
  ${fig('22-gm-transfers.png', 'Branch transfers: what left, what arrived, and what is still in transit', `<p>Moving stock between branches &mdash; a slow seller at one shop is very often a fast seller at
another, and shifting it is cheaper than writing it off when it expires.</p>
<p>A transfer keeps the <b>batch number and expiry date</b> intact, so traceability survives the
move. If NAFDAC recalls that batch six months later you can still find it, whichever shop it ended
up in.</p>
<p>The receiving branch must <b>confirm arrival</b> before the stock becomes sellable there. Until
they do it is in transit: gone from the sender's sellable figure, not yet in the receiver's. That is
what stops the same pack being sold twice, and it is also what makes a disappearance visible
&mdash; stock that never gets confirmed stays on the in-transit list with both branches named.</p>
<p>A partial receipt is allowed. If eight of ten cartons arrive, receive eight; the balance stays in
transit and the discrepancy is on the record rather than in somebody's memory.</p>`)}
  <h3>Buying</h3>
  ${fig('23-gm-purchase-orders.png', 'Purchase orders — ordered, received, and what is still outstanding', `<p>What has been ordered, what has arrived, and what is still outstanding.</p>
<p>Receiving a delivery is where cost price, selling price, batch number and expiry all enter the system —
which is why stock cannot simply be typed in from nowhere. Everything on your shelves arrived through a
delivery, and can be traced back to one.</p>
<p>PharmaRidge refuses to receive stock that has already expired.</p>`)}
  <h3>People and hours</h3>
  ${fig('24-gm-attendance.png', 'Attendance with GPS verification and computed hours for payroll', `<p>Who clocked in, where they were when they did it, and how many hours the shift came
to.</p>
<p>If a branch uses GPS, PharmaRidge checks the person is actually at the shop. A failed check — common
indoors, with a weak signal — does <b>not</b> reject the shift; it flags it for a manager to review. The
hours column is computed from the two timestamps, so payroll is not somebody subtracting times by hand.</p>`)}
</section>

<!-- ============ 6. BRANCH MANAGER ============ -->
<section class="page">
  <span class="role-chip">Chapter for the BRANCH MANAGER</span>
  <h2>6. The Branch Manager</h2>
  <p class="lead">You run one shop. PharmaRidge shows you that shop and nothing else — not as a
  restriction, but so that every figure you look at is yours.</p>
  ${fig('30-bm-dashboard.png', 'A Branch Manager sees only their own branch — the branch name is shown in the top bar instead of a branch selector', `<p>A Branch Manager sees one shop: their own.</p>
<p>Notice the top bar — where an Owner has a branch selector, a Branch Manager has their branch <b>name</b>.
That is not a restriction so much as a guarantee: every figure on every screen they open is theirs, with no
possibility of reading another branch's numbers by mistake.</p>`)}
  <h3>What you control at your branch</h3>
  <ul>
    <li>Open and close the till, and force-close a cashier's till if they left without doing it.</li>
    <li>Set prices at your branch, run stocktakes, and write off damaged stock.</li>
    <li>Void a sale with a reason, and approve expenses.</li>
    <li>Set customer credit limits and authorise an override.</li>
    <li>Move money in and out of <b>your</b> branch's safe.</li>
    <li>Review attendance, and correct a clock-in that failed the GPS check.</li>
  </ul>
  <h3>What you cannot do</h3>
  <ul>
    <li>See or touch another branch — including its safe, its stock and its staff.</li>
    <li>Open a new branch, or change anyone's role to Owner.</li>
    <li>Change VAT, withholding-tax rates, or the permission switches.</li>
  </ul>

  <h3>The two pots of cash</h3>
  <p>Your shop holds money in two places, and PharmaRidge treats them as genuinely different things.</p>
  ${fig('31-bm-till-and-safe.png', 'The till drawer above, the branch safe below — counted separately, because they are separate', `<p>The two pots of cash at a shop, on one screen, because they are genuinely
different things.</p>
<p>The <b>till drawer</b> at the top is the counter cash box. It is counted and reconciled at the end of every
shift, and it is the only pot a cashier handles all day.</p>
<p>The <b>branch safe</b> below is the shop's reserve. It is not part of the till count, no sale ever touches
it, and it is what pays for a delivery or the rent that the drawer could never cover.</p>
<p>Money moves between them explicitly and never by accident.</p>`)}
  ${fig('32-bm-safe-deposit.png', 'Recording money into the safe: what, how much, and why', `<p>Recording money into the safe: how much, and <b>why</b>.</p>
<p>The reason is required, not optional. It is the only record anyone will have in six weeks' time of why cash
moved, and every movement also names the person who recorded it.</p>
<p>The four movement types cover what actually happens in a shop: a deposit into the safe, a withdrawal out of
it, a sweep of the drawer into the safe at close of day, and topping the drawer back up for change.</p>`)}
  ${fig('34b-bm-stocktake.png', 'Counting the shelves — a stocktake at your own branch', `<p>Counting the shelves against what the system believes you have.</p>
<p>PharmaRidge <b>records the variance</b> rather than silently overwriting the figure, so a
shortfall is visible as a shortfall &mdash; which is the entire point of counting. Software that
quietly adopts your count destroys the only evidence that anything went missing.</p>
<p>Only one stocktake can be open at a branch at a time, so two people cannot count the same shelves
against each other and commit contradictory numbers.</p>
<p>Counting <b>zero</b> is a valid, meaningful result &mdash; it is how an empty shelf is recorded
&mdash; and it is treated differently from not having counted an item at all.</p>
<p>Variances on <b>controlled drugs</b> are held to a higher standard: the write-off needs a
manager, and the entry lands in the controlled register where an inspector will look for it. A
counting session that would quietly write off a controlled substance is refused.</p>
<p>Count during quiet hours where you can. Stock keeps moving while you count, and the variance is
measured against the batch's quantity <i>at the moment you record it</i>, not against a figure
frozen when the session opened.</p>`)}

  <h3>What your cashiers may spend</h3>
  <p>Your cashiers can buy things for the shop out of the drawer, the safe, or both. How much they may
  take <b>from the safe</b> in one purchase is yours to set — and you can set it to no limit at all by
  entering <b>0</b>. Anything above the limit comes to you.</p>
  ${fig('34-bm-safe-allowance.png', 'The cashiers&rsquo; safe allowance — the one plan setting a manager controls', `<p>The one plan setting a manager controls: <b>how much your cashiers may take from the
safe for a single purchase</b>.</p>
<p>Set a figure and anything larger comes to you. Set it to <b>0 and there is no limit</b>. Untick the box
entirely and cashiers cannot touch the safe at all, though they can still spend from the till drawer.</p>
<p>Everything else on the Owner's plan screen — VAT, withholding-tax rates, and what <i>managers</i> may do —
stays with the Owner. A manager who could widen their own authority would not really be restricted at all.</p>`)}
  <div class="note">
    This is the only setting on that screen a manager can change. VAT, withholding-tax rates and what
    <i>managers</i> may do all belong to the Owner — a manager who could widen their own authority
    would not really be restricted at all.
  </div>

  <h3>Your staff</h3>
  ${fig('33-bm-users-scoped.png', 'Only your own branch&rsquo;s staff appear', `<p>A Branch Manager's staff list contains their own branch and nobody else. This is not a filter
they can clear &mdash; the other branches' people are not sent to their device at all.</p>
<p>They can hire, review attendance for, reset the PIN of, and deactivate their own people. They
cannot see another branch's staff, cannot move somebody between branches, and cannot create an
Owner or promote anyone to one.</p>
<p>The distinction that matters here is between a <b>Branch Manager</b> and a <b>General Manager</b>.
Both are the same role; what separates them is whether the account is pinned to a branch. Pin it and
they see one shop. Leave it unpinned and they see the whole estate. You change one from the other by
transferring the account, which keeps their history intact rather than creating a second login for
the same person.</p>
<p>A locked-out manager is unlocked by anyone ranked above them, immediately, without contacting
support.</p>`)}
</section>

<!-- ============ 7. STAFF ============ -->
<section class="page">
  <span class="role-chip">Chapter for COUNTER STAFF</span>
  <h2>7. Counter Staff</h2>
  <p class="lead">You sell, you take money, you clock in and out. PharmaRidge is designed so that the
  busiest person in the shop has the fewest steps.</p>
  ${fig('40-cashier-pos-empty.png', 'The Point of Sale, waiting for the next customer', `<p>The Point of Sale, waiting for the next customer. This is where a cashier spends
almost the entire day.</p>
<p>The layout is deliberately plain: find the product on the left, the cart builds on the right, take the
money at the bottom. There is no navigation to learn between customers.</p>
<p>If the network drops mid-shift, keep selling. Sales are stored on the device and sent automatically when
the signal returns.</p>`)}
  <h3>Making a sale</h3>
  <ol>
    <li><b>Find the product.</b> Type any part of the name — brand or generic.</li>
    <li><b>Add it.</b> PharmaRidge picks the nearest-expiry batch automatically, so old stock always
      leaves first. You do not have to think about batches.</li>
    <li><b>Choose the unit</b> — single, pack or carton — and the price follows.</li>
    <li><b>Take the money.</b> Cash, POS card, transfer, or credit. You can split one sale across more
      than one method.</li>
    <li><b>Complete the sale</b> and hand over the receipt.</li>
  </ol>
  ${fig('41-cashier-pos-search.png', 'Searching by name — brand or generic both work', `<p>Type any part of the name — brand or generic. PharmaRidge searches both, so
"paracetamol" finds Panadol and vice versa.</p>
<p>Adding an item picks the correct batch for you: the one expiring soonest. You choose the unit — a single,
a pack, or a carton — and the price follows automatically.</p>
<p>Prescription-only and controlled medicines will stop and ask for the prescriber or buyer details a PCN
inspector expects to see. That is the system protecting the pharmacy's licence, not obstructing the sale.</p>`)}
</section>

<section class="page">
  <h3>When there is no change to give</h3>
  <p>The customer's goods come to N400. They hand you N500. There is no N100 note in the drawer.</p>
  <p>Type <b>100</b> into <b>Change Owed</b>, and put the customer's name or phone number in the box
  that appears. PharmaRidge does the rest: the money stays in the till where it belongs, the customer
  gets a <b>7-digit claim code</b> printed on their receipt, and the shop now formally owes them N100.</p>
  ${fig('42-cashier-change-owed.png', 'Recording change the shop could not give — a name or a phone number is enough', `<p>The commonest event behind a Nigerian counter: the goods come to N400, the
customer hands over N500, and there is no N100 note in the drawer.</p>
<p>Type <b>100</b> into <i>Change Owed</i> and put the customer's name or phone number in the box that
appears — either one is enough. The money stays in the till where it belongs, the customer gets a
<b>7-digit claim code</b> printed on their receipt, and the shop now formally owes them N100.</p>
<p>This protects <b>you</b>. Before, that N100 sat in your drawer with no record, and at close of day your
till read N100 over — looking like your discrepancy. Now the drawer balances exactly.</p>`)}
  <div class="note">
    <b>Why this matters to you.</b> Before, that N100 sat in your drawer with no record. At close of
    day your till showed N100 more than the system expected, and it looked like <i>your</i>
    discrepancy. Now the drawer balances exactly, and the customer's claim is the shop's problem, not
    your memory.
  </div>
  <h3>Buying something for the shop</h3>
  <p>When you are sent to buy diesel, pay the okada, or collect a carton from the depot, record it on
  the <b>Expenses</b> screen. You choose where the money came from:</p>
  <ul>
    <li><b>Cash</b> — out of the till drawer in front of you.</li>
    <li><b>Safe</b> — out of the shop's cash reserve.</li>
    <li><b>Both</b> — whatever was in the drawer, and the rest from the safe.</li>
  </ul>
  <p>For a combination, type only what came out of the <b>drawer</b>. PharmaRidge works out the rest
  and shows it to you before you save, so you never have to do the subtraction.</p>
  ${fig('43-cashier-split-purchase.png', 'A N20,000 purchase: N8,000 from the drawer, and the screen confirms the safe covers the remaining N12,000', `<p>Buying something for the shop that the till drawer alone cannot cover.</p>
<p>Choose <b>Both</b>, and type only what came out of the <b>drawer</b>. PharmaRidge works out the rest and
shows it to you before you save — here, N8,000 from the drawer and the remaining N12,000 from the safe.</p>
<p>Each pot is then reduced by exactly its own share. Before this existed, a purchase like this had to be
recorded as though it all came from one place, whichever you chose was wrong, and one of the two came up
short at close of day.</p>
<p>The safe has a limit your manager sets; the drawer is limited only by what is actually in it.</p>`)}
  <div class="note">
    <b>Why this matters.</b> Before, a purchase like this had to be recorded as if it all came from one
    place. Whichever you picked was wrong, and at close of day one of the two came up short — usually
    looking like <i>your</i> mistake. Now each pot is reduced by exactly what left it.
  </div>
  <div class="warn">
    <b>There is a limit on the safe, and your manager sets it.</b> You can take up to whatever your
    manager or the Owner has allowed for one purchase — anything larger needs them. The till drawer is
    limited only by what is actually in it: PharmaRidge will not let you record more cash leaving the
    drawer than the drawer holds.
  </div>
  <p>You can record what you spent, but you cannot browse the pharmacy's other costs — the rent, the
  salaries, what other branches spend. Your manager sees the full report.</p>

  <h3>Your till</h3>
  <p>Open the till with the float you were given. Sell all day. At close, count the drawer and type
  what you counted — PharmaRidge shows you what it expected, so you can find a mistake before you
  commit the count, not after.</p>
  ${fig('44-cashier-till.png', 'Opening, watching, and closing the drawer', `<p>Open the till at the start of your shift with the float you were given. Sell all day.
At the end, count the drawer and type what you counted.</p>
<p>PharmaRidge shows you the figure it <b>expected</b> before you commit, so if there is a difference you can
look for it while the shift is still fresh, rather than discovering it afterwards.</p>
<p>That expected figure accounts for everything real: cash sales, cash you took for a debt repayment, cash
spent on a purchase, and change you kept because you had no note to give.</p>`)}

  <h3>Closing your shift — the order to do it in</h3>
  <ol>
    <li><b>Finish every sale.</b> Nothing half-rung. If a sale is waiting on a prescription detail,
    complete it or cancel it.</li>
    <li><b>Record anything you spent</b> out of the drawer — transport, diesel, a delivery paid at the
    door. If it is not recorded, it will show up as a shortage and look like missing money.</li>
    <li><b>Deposit large notes to the safe</b> if that is your shop's rule, before you count.</li>
    <li><b>Count the drawer physically.</b> Count it twice if the figures are large.</li>
    <li><b>Type what you actually counted</b> — not what you think it should be. The system already
    knows what it expects; typing the expected figure defeats the entire check.</li>
    <li><b>Look at the difference</b> before you commit. A small shortage is usually an unrecorded
    expense or change given from the wrong pot, and it is far easier to find now than tomorrow.</li>
    <li><b>Clock out.</b></li>
  </ol>
  <div class="note"><b>If you are short, say so and close anyway.</b> A recorded shortage with an
  honest explanation is a normal event that your manager can investigate. A drawer left open
  overnight, or a count typed to match, is what turns a small discrepancy into a real problem.</div>
</section>

<section class="page">
  <h3>What you may and may not do</h3>
  <ul>
    <li><b>You may void your own mistake</b> — your own sale, within the window the Owner set
      (15 minutes by default), while the till is still open, and with a reason. A mis-keyed sale at a
      busy counter should not need a phone call.</li>
    <li><b>You may not void somebody else's sale.</b> That is not correcting a mistake, it is reversing
      another person's takings.</li>
    <li><b>You may write off a small quantity</b> of damaged stock — up to the limit the Owner set
      (5 units by default). Anything larger needs a manager.</li>
    <li><b>You may not see what the pharmacy owes its suppliers</b>, open the accounts, or change
      anyone's access.</li>
    <li><b>You may buy things for the shop</b> from the drawer, the safe, or both — the safe up to the
      allowance your manager set. You cannot browse the pharmacy's other costs.</li>
    <li><b>You may not deposit into or withdraw from the safe directly.</b> Spending it on a recorded
      purchase is allowed within your allowance; moving the money itself is a manager's job.</li>
  </ul>
  ${fig('44-cashier-sales.png', 'Today&rsquo;s sales — each one showing who served it', `<p>Everything sold today, and who served each sale.</p>
<p>You can void <b>your own</b> mistake — your own sale, within the window the Owner set (15 minutes by
default), while the till is still open, and with a reason. A mis-keyed sale at a busy counter should not need
a phone call.</p>
<p>You cannot void somebody else's sale. That is not correcting a mistake; it is reversing another person's
takings, and it needs a manager.</p>`)}
  <h3>Clocking in</h3>
  <p>Clock in when you arrive and out when you leave. If your branch uses GPS, PharmaRidge checks you
  are actually at the shop; if the check fails — a weak signal indoors is common — the shift is flagged
  for your manager to review rather than silently rejected.</p>
  ${fig('45-cashier-attendance.png', 'Clock in, clock out, and the hours that feed payroll', `<p>Clock in when you arrive and out when you leave. The hours computed here are what
feed payroll.</p>
<p>If your branch uses GPS, PharmaRidge checks you are at the shop. If the check fails — a weak signal indoors
is common — your shift is <b>flagged for your manager to review</b>, not rejected. You will not lose a day's
pay to a bad signal.</p>`)}
</section>

<section class="page">
  <h3>Working from a phone</h3>
  <p>The full Point of Sale runs on a phone. If the network drops, keep selling — sales are stored on
  the device and sent automatically when the signal returns.</p>
  <div class="note"><b>The phone views beside the POS and till plates above are the actual same screens at mobile width.</b> They are shown once, next to their laptop counterparts, so a buyer can compare the working layout without paging through repeated screenshots. A phone can run the counter when the laptop is elsewhere; the authority, stock controls and receipt trail remain the same.</div>
</section>

<!-- ============ 8. SAFE ============ -->
<section class="page">
  <h2>8. The branch safe</h2>
  <p class="lead">A pharmacy does not pay its rent out of the counter drawer. PharmaRidge models the
  shop's cash reserve as a separate pot, because that is what it is.</p>
  <table>
    <thead><tr><th style="width:22%"></th><th>The till drawer</th><th>The branch safe</th></tr></thead>
    <tbody>
      <tr><td><b>What it is</b></td><td>The counter cash box</td><td>The shop's cash reserve</td></tr>
      <tr><td><b>Counted</b></td><td>At every till close</td><td>Not part of the till count</td></tr>
      <tr><td><b>Who touches it</b></td><td>Cashiers, all day</td><td>Managers and the Owner only</td></tr>
      <tr><td><b>Typically pays for</b></td><td>Small running costs, change</td><td>Deliveries, rent, salaries</td></tr>
    </tbody>
  </table>
  <h3>Why it exists</h3>
  <p>PharmaRidge will not let you record a N50,000 cash expense against a drawer holding N25,000,
  because that produces a cash figure no shop can physically have, and it makes every later count
  meaningless. But the payment is real — it came from the safe. Record it as <b>Safe</b>, and the
  books follow the money correctly.</p>
  <h3>Who can move it</h3>
  ${permissionTable([
    ['Move any branch\'s safe (deposit / withdraw)', 'Yes', 'Yes', 'No', 'No'],
    ['Move their OWN branch\'s safe', 'Yes', 'Yes', 'Yes', 'No'],
    ['See the safe balance', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Pay an expense from the safe', 'Yes', 'Yes', 'Own branch', 'Up to their allowance'],
    ['Pay a supplier from the safe', 'Yes', 'Yes', 'Own branch', 'Up to their allowance'],
    ['Pay from the drawer AND the safe together', 'Yes', 'Yes', 'Own branch', 'Up to their allowance'],
    ['Set the cashiers\' safe allowance', 'Yes', 'Yes', 'Yes', 'No'],
  ])}
  <h3>Paying from both pots at once</h3>
  <p>A purchase is often funded from whatever was in the drawer plus the rest from the safe. Record it
  as <b>Both</b>, say how much came from the drawer, and PharmaRidge takes the remainder from the safe.
  Each pot is reduced by exactly its own share, and each is checked separately: the drawer must
  physically hold its part, and the safe must hold its part.</p>
  <h3>What a cashier may take</h3>
  <p>Cashiers can spend from the safe up to a limit set by <b>the Owner or any manager</b>. Setting the
  limit to <b>0 means no limit</b>; unticking the box stops safe spending by cashiers entirely, while
  still leaving them free to spend from the drawer.</p>
  <div class="note">
    <b>PharmaRidge support cannot move your cash.</b> The vendor's own support account can read your
    settings and help you recover a locked-out owner, but it is refused outright from every safe
    movement. Your money is moved by your people only.
  </div>
  <p>Every movement records who, how much, when and <b>why</b> — the reason is required, not optional.
  The balance is always the sum of that history, so it cannot drift.</p>

  <h3>The five cash movements, and what each one is for</h3>
  <table>
    <thead><tr><th style="width:26%">Movement</th><th>When you use it</th></tr></thead>
    <tbody>
      <tr><td><b>Deposit to safe</b></td>
          <td>Taking a large amount out of the drawer during the day so it is not sitting in an open
          till. The commonest movement in a busy shop.</td></tr>
      <tr><td><b>Withdraw from safe</b></td>
          <td>Money leaving the shop — banking it, or the owner collecting takings.</td></tr>
      <tr><td><b>Transfer to till</b></td>
          <td>Refilling the drawer: small notes for change, or funding a purchase the cashier is about
          to make.</td></tr>
      <tr><td><b>Spend from safe</b></td>
          <td>Paying for something directly out of the safe — a supplier delivery, diesel, a repair —
          without the money passing through the drawer.</td></tr>
      <tr><td><b>Split payment</b></td>
          <td>A purchase too big for the drawer alone: part drawer, part safe. Each part is charged to
          the right pot, so neither reconciliation is thrown out.</td></tr>
    </tbody>
  </table>

  <h3>If the drawer does not balance</h3>
  <p>A shortage or an overage is recorded, not hidden. PharmaRidge posts the difference to a
  <b>cash over/short</b> account and closes the shift honestly, so the books always agree with the
  cash that is physically there. What you get is a running record of which shifts and which people
  are consistently out — which is the information that actually fixes the problem.</p>
  <p>A cash purchase larger than the drawer holds is <b>refused</b>, and the message tells you what
  the drawer has and suggests taking the balance from the safe. That refusal is deliberate: allowing
  it would leave the till showing negative expected cash and impossible to close.</p>
</section>

<!-- ============ 9. CHANGE OWED ============ -->
<section class="page">
  <h2>9. When you have no change</h2>
  <p class="lead">The most ordinary event behind a Nigerian counter, and the one most software has no
  answer for.</p>
  ${fig('50-change-owed-list.png', 'Every claim the shop still owes, with its code, the customer, what they bought, and when', `<p>Everything the shop currently owes customers in change, with the claim code, the
customer, what they bought and when.</p>
<p>Any cashier can open this and pay a claim out — deliberately, because the person who meets the returning
customer is whoever is on duty, not necessarily whoever took the original sale. Requiring a manager would
guarantee the money gets paid from the drawer with nobody writing it down.</p>
<p>A claim can only be settled <b>once</b>. If a colleague already paid it, PharmaRidge refuses and tells you
when and by whom.</p>`)}
  <h3>How it works, end to end</h3>
  <ol>
    <li><b>At the counter.</b> The cashier types the amount owed and the customer's name or phone.</li>
    <li><b>On the receipt.</b> The customer walks out with a 7-digit claim code printed on their
      receipt, next to the amount.</li>
    <li><b>In the till.</b> The money stays in the drawer — and the drawer still balances, because
      PharmaRidge knows the cash is there and knows it is not the shop's.</li>
    <li><b>In the books.</b> It is recorded as a liability, not as income. Your profit figure is not
      flattered by money you owe somebody.</li>
    <li><b>When they come back.</b> Any cashier can find the claim and pay it out — no manager needed,
      because the person who meets the returning customer is whoever is on duty.</li>
  </ol>
  ${fig('51-change-owed-search.png', 'Lost the slip? Search by name or phone number instead of the code', `<p>The customer has come back but lost the slip with their code. Search by their
<b>name</b> or their <b>phone number</b> instead — partial matches work.</p>
<p>This is why the cashier is asked for a name or number at the counter in the first place. The 7-digit code
is the fast path, never the only one, because a lost receipt must not mean lost money.</p>`)}
  <h3>Three ways to find a claim</h3>
  <ul>
    <li><b>The 7-digit code</b> — fastest, if they kept the receipt.</li>
    <li><b>Their name</b> — partial matches work.</li>
    <li><b>Their phone number</b> — partial matches work.</li>
  </ul>
  <h3>Settling it</h3>
  <ul>
    <li><b>Pay it out in cash</b> when they return.</li>
    <li><b>Apply it to a new purchase</b> — they buy something today and the change covers part of it.</li>
    <li><b>Write it off</b> — Owner only, with a reason. Unclaimed change never expires on its own and
      never quietly becomes the shop's money.</li>
  </ul>
  <div class="note">
    A claim can only be settled once. If a colleague already paid it, PharmaRidge refuses and tells you
    when and by whom — so nobody is paid twice for the same N100.
  </div>

  <h3>The questions owners ask about this</h3>
  <table>
    <thead><tr><th style="width:38%">Question</th><th>Answer</th></tr></thead>
    <tbody>
      <tr><td><b>Does unclaimed change expire?</b></td>
          <td>Never on its own. It stays on your books as money you owe until the customer collects it
          or you write it off deliberately. Nothing in the system quietly converts it into profit.</td></tr>
      <tr><td><b>What if the customer loses the slip?</b></td>
          <td>Their name or phone number finds the claim. The seven-digit code is a convenience for
          speed at the counter, not a condition of being paid.</td></tr>
      <tr><td><b>Can a cashier pay a claim?</b></td>
          <td>Yes — settling a claim is ordinary counter work. What a cashier cannot do is
          <i>write one off</i>; that is the Owner's decision and it is recorded with a reason.</td></tr>
      <tr><td><b>Where does it show in the accounts?</b></td>
          <td>As a liability, not as income. Your profit figure is never inflated by money you are
          still holding for somebody else. A write-off later appears as other income, kept out of
          Sales Revenue so your trading margin stays honest.</td></tr>
      <tr><td><b>What happens if the sale is voided?</b></td>
          <td>An outstanding claim is cancelled with the sale — the shop cannot owe change on a sale
          that no longer exists. A claim the customer has <i>already collected</i> stays on record,
          because that money genuinely left the drawer.</td></tr>
      <tr><td><b>Does the till still balance?</b></td>
          <td>Yes. The cash you kept is still in the drawer and the system knows it is spoken for, so
          your expected cash at close-of-day already accounts for it.</td></tr>
    </tbody>
  </table>
</section>

<!-- ============ 10. PERMISSIONS ============ -->
<section class="page">
  <h2>10. Who can do what</h2>
  <p class="lead">The complete picture. "Own branch" means the rule applies only at the branch that
  person is assigned to.</p>

  <h4>Selling and the till</h4>
  ${permissionTable([
    ['Make a sale', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Open / close a till', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Force-close somebody else\'s till (with a reason)', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Void own sale within the window', 'Yes', 'Yes', 'Yes', 'Yes*'],
    ['Void anybody\'s sale, any time', 'Yes', 'Yes*', 'Yes*', 'No'],
    ['Record change owed to a customer', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Pay out change owed', 'Yes', 'Yes', 'Yes', 'Yes'],
    ['Write off unclaimed change', 'Yes', 'No', 'No', 'No'],
  ])}

  <h4>Stock</h4>
  ${permissionTable([
    ['See stock and expiry', 'Yes', 'Yes', 'Own branch', 'Own branch'],
    ['Order stock / receive a delivery', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Transfer stock between branches', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Change a price', 'Yes', 'Yes*', 'Yes*', 'No'],
    ['Write off damaged stock (small amount)', 'Yes', 'Yes', 'Yes', 'Yes*'],
    ['Write off any amount', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Run a stocktake', 'Yes', 'Yes', 'Own branch', 'Yes'],
  ])}

  <h4>Money</h4>
  ${permissionTable([
    ['Record an expense / purchase', 'Yes', 'Yes', 'Own branch', 'Own branch'],
    ['See every expense the pharmacy has recorded', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Pay from the till drawer', 'Yes', 'Yes', 'Own branch', 'Own branch'],
    ['Pay from the branch safe', 'Yes', 'Yes', 'Own branch', 'Up to allowance'],
    ['Pay from BOTH at once', 'Yes', 'Yes', 'Own branch', 'Up to allowance'],
    ['Set the cashiers\' safe allowance (0 = no limit)', 'Yes', 'Yes', 'Yes', 'No'],
    ['Approve an expense', 'Yes', 'Yes*', 'Yes*', 'No'],
    ['See what is owed to suppliers', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Pay a supplier', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Set a customer credit limit', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Authorise a credit-limit override', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Move the branch safe', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Open the accounts / general ledger', 'Yes', 'Yes', 'Yes', 'No'],
  ])}
  <p style="font-size:9pt;color:#5b6b64;">* Subject to a switch the Owner controls. The Owner can turn
  off manager voids, manager expense approval and manager price changes independently; and can set
  whether cashiers may void at all, within how many minutes, and how much stock they may write off.</p>
</section>

<section class="page">
  <h4>People and settings</h4>
  ${permissionTable([
    ['Hire a member of staff', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Promote / transfer somebody', 'Yes', 'Yes', 'No', 'No'],
    ['Deactivate an account', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Create an Owner account', 'Yes', 'No', 'No', 'No'],
    ['Open a new branch', 'Yes', 'Yes', 'No', 'No'],
    ['Close / relocate a branch', 'Yes', 'Yes', 'No', 'No'],
    ['Review flagged attendance', 'Yes', 'Yes', 'Own branch', 'No'],
    ['Turn VAT on / set the rate', 'Yes', 'No', 'No', 'No'],
    ['Edit withholding-tax rates', 'Yes', 'No', 'No', 'No'],
    ['Set what managers may do', 'Yes', 'No', 'No', 'No'],
    ['Set what cashiers may do', 'Yes', 'No', 'No', 'No'],
    ['Preview or permanently remove business data', 'Yes', 'No — capacity warning only', 'No', 'No'],
  ])}

  <h3>The rules that protect you from yourself</h3>
  <ul>
    <li><b>The last Owner cannot be removed.</b> Not deactivated, not deleted, not demoted — because
      no manager could restore one.</li>
    <li><b>Nobody can act above their own level.</b> A manager cannot edit an Owner's account, and a
      cashier cannot edit anybody's.</li>
    <li><b>A closed branch keeps its history</b> and stops consuming a paid slot. You can reopen it at
      a new address, carrying the history over or starting fresh — your choice, asked explicitly.</li>
    <li><b>Deactivating somebody closes their open shift</b> automatically, so a departed employee is
      never left permanently clocked in.</li>
  </ul>

  <h3>The vendor's own account</h3>
  <p>PharmaRidge support has an account for helping you: it can see your plan, adjust your branch and
  staff limits, and recover a locked-out owner. It <b>cannot</b> move your safe, and it is excluded
  from the staff count you pay for.</p>
  ${fig('60-admin-portal.png', 'The support portal — clearly labelled as someone else&rsquo;s account, so a support engineer is never in doubt whose settings they are changing', `<p>PharmaRidge support's own view of your account, shown here for completeness.</p>
<p>Support can see your plan, adjust your branch and staff limits, and recover an owner who has locked
themselves out. Support <b>cannot</b> move money in or out of your safe — that is refused outright — and the
support seat is never counted against the staff you pay for.</p>
<p>The screen is clearly labelled as somebody else's account so a support engineer is never in any doubt whose
settings they are changing.</p>`)}
</section>

<!-- ============ 9b. TAKING A DELIVERY ============ -->
<section class="page">
  <h2>Taking a delivery from your supplier</h2>
  <p class="lead">Your supplier does not sell you tablets. They sell you <b>cartons</b>, and
  they send one invoice for the lot. PharmaRidge records a delivery the way it actually
  arrives, and works out the rest itself.</p>

  <h3>Why this matters more than it sounds</h3>
  <p>Most stock systems make the storekeeper do the arithmetic at the delivery door: ten
  cartons, ten packs to a carton, ten tablets to a pack &mdash; type 1,000. It works until
  somebody is counting a delivery in the rain with a driver waiting, and then it is 100, or
  10,000, and nobody notices for a month. Every figure the shop reports afterwards &mdash;
  stock value, margin, reorder level &mdash; is built on that one number.</p>
  <p>So the system asks the question the way the delivery note is written, and does the
  multiplication.</p>

  <h3>The four things it asks</h3>
  <table>
    <thead><tr><th style="width:30%">What it asks</th><th>Why</th></tr></thead>
    <tbody>
      <tr><td><b>Arrived as</b> &mdash; cartons, packs or pieces</td>
          <td>Pick whichever matches the delivery note. Choosing <i>cartons</i> then asks how
          many packs are in a carton and how many pieces are in a pack; choosing <i>packs</i>
          asks only for the pieces; choosing <i>pieces</i> asks nothing further. You are never
          shown a box that does not apply.</td></tr>
      <tr><td><b>How many</b></td>
          <td>Ten cartons is ten. The conversion to pieces is shown live, in words, before
          you save: <i>&ldquo;10 cartons &times; 10 packs &times; 12 pieces = 1,200 pieces onto
          the shelf&rdquo;</i>. If that sentence is wrong, the delivery note and the form
          disagree &mdash; and you find out now rather than at stocktake.</td></tr>
      <tr><td><b>Total paid for this line</b></td>
          <td>The figure on the invoice. PharmaRidge divides it: cost per carton, per pack and
          per piece, all shown before you commit. Nobody has to work out what one tablet cost.</td></tr>
      <tr><td><b>Sold over the counter as</b></td>
          <td>How the counter will sell it &mdash; and it does <b>not</b> have to match how it
          arrived. Buying by the carton and selling by the tablet is the whole pharmacy
          business. The selling <i>price</i> can be left blank now and set later on the Stock
          screen.</td></tr>
    </tbody>
  </table>

  <div class="note"><b>Every delivery still carries its batch number and expiry date.</b>
  Those are per LINE, not per delivery, so one goods-received entry can hold six cartons
  expiring in 2027 and four expiring in 2028 as two separate batches. That is deliberate:
  they must stay separate for the shop to sell the nearer expiry first and for a recall to
  find the right stock. Add a line for each batch that arrived.</div>

  <h3>What the system does with it</h3>
  <ul>
    <li><b>Converts to pieces</b> and puts that on the shelf, because a sale can be a single
      tablet and the shelf count has to be able to express one.</li>
    <li><b>Remembers the nesting as delivered</b>, on that batch. The same drug arrives 10&times;10
      from one supplier and 24&times;1 from another; recording it per delivery is what makes
      &ldquo;a carton&rdquo; mean the right number for the stock you actually hold.</li>
    <li><b>Splits the invoice total</b> into per-piece, per-pack and per-carton cost, keeping
      full precision so the stock value always reconciles back to what you actually paid, to
      the kobo &mdash; even when the division is not exact.</li>
    <li><b>Refuses what cannot be true.</b> A carton delivery with no carton size, half a
      carton, a carton of 99,999,999 packs, or selling by the carton something that arrived
      loose &mdash; each is refused with a plain sentence saying which line and what is
      missing.</li>
  </ul>

  <h3>Receiving part of an order</h3>
  <p>If only some of the order arrives, receive what came. The order stays open at
  <b>PARTIALLY RECEIVED</b> and the balance can be recorded whenever the rest turns up, on
  its own batch numbers and its own invoice figure. You are never forced to pretend a
  delivery was complete to close the paperwork.</p>
</section>

<!-- ============ 10a. WORKING OFFLINE ============ -->
<section class="page">
  <h2>When the network drops &mdash; and why that is the point</h2>
  <p class="lead">Nigerian pharmacies do not have reliable connectivity, and software that assumes
  otherwise stops the counter. PharmaRidge is built the other way round: <b>the shop keeps trading,
  and the system catches up.</b></p>

  <h3>Why PharmaRidge does this and most systems do not</h3>
  <p>Cloud pharmacy systems put the database somewhere else and talk to it on every keystroke. When
  the line drops, the till stops. The usual workaround is a paper notebook and re-keying in the
  evening &mdash; which is where the errors, the missing sales and the arguments come from.</p>
  <p>PharmaRidge keeps a full working copy <i>on the device</i>. A sale rung up with no signal is a
  real sale: it prints, it takes payment, it comes off the shelf count. When the connection returns
  it is sent up and merged. Nobody re-types anything.</p>
  <p>That design creates one hard problem, and it is the problem most offline-capable software gets
  wrong: <b>what happens when work done offline arrives after the world has changed?</b> Two answers
  in this product exist purely for that, and both were found by testing the collision rather than
  the happy path.</p>

  <h3>A transfer that corrects itself</h3>
  <p>Your manager sends a whole batch of Amoxil from Ikeja to Surulere. Meanwhile a cashier at
  <i>Ikeja</i>, working with no signal, sells three of them over the counter. That sale is
  legitimate &mdash; the stock was physically there and a customer walked out with it &mdash; but it
  only reaches the server after the transfer was raised.</p>
  <p>Naive software refuses the delivery: the sending branch no longer has what the paperwork says.
  The stock is then stranded, belonging to neither shop, until somebody notices and unpicks it by
  hand. <b>PharmaRidge corrects the transfer instead.</b> It moves what is actually on the shelf,
  records that three units went to a sale, and completes:</p>
  <table>
    <thead><tr><th style="width:34%">What the record shows</th><th>Why it is kept</th></tr></thead>
    <tbody>
      <tr><td><b>Quantity sent: 156</b></td><td>What the manager intended. Never rewritten, so the
        original instruction is always readable.</td></tr>
      <tr><td><b>Quantity received: 153</b></td><td>What actually moved, and exactly what the
        destination shelf now holds.</td></tr>
      <tr><td><b>Shortfall: 3</b></td><td>The difference, with a plain-English note. Sent = received
        + shortfall, always &mdash; nothing is invented and nothing quietly disappears.</td></tr>
    </tbody>
  </table>
  <p>The shortfall is <b>flagged, not silent</b>. An offline sale is the ordinary explanation, but a
  miscount or a theft produces exactly the same arithmetic, so a manager sees the difference and can
  ask. If the batch was sold out entirely before the transfer arrived, the transfer is cancelled
  automatically with the reason recorded &mdash; rather than sitting in a queue forever.</p>

  <h3>Nobody is moved out from under their own work</h3>
  <p>The same hazard applies to people. A cashier working offline at Ikeja is reassigned to Surulere
  mid-shift. Their queued sales, their open till and their clock-in all belong to a branch they are
  no longer attached to, and they find out when the device reconnects and the work is refused.</p>
  <p>So a staff transfer now works like a stock transfer: <b>it is proposed, and the person confirms
  it.</b></p>
  <ul>
    <li>The manager raises the transfer with a reason, as before.</li>
    <li><b>Nothing changes yet.</b> The person keeps working exactly where they are, so anything they
      record offline stays valid.</li>
    <li>They see the request the next time they sign in, with where they are going and who asked.</li>
    <li>They confirm once they have closed their till and finished at the old counter &mdash; and only
      then do they actually move.</li>
    <li>If they cannot move yet they say so, with a reason their manager can read.</li>
  </ul>
  <div class="note"><b>And it can never become a new way to get stuck.</b> Somebody who has resigned,
  lost their phone or simply will not answer would otherwise leave a transfer unresolved forever. An
  <b>Owner or General Manager can force it through</b> &mdash; recorded as forced, so &ldquo;they
  agreed&rdquo; and &ldquo;it was imposed&rdquo; are never confused in the history. A Branch Manager
  cannot.</div>

  <h3>What this is worth to you</h3>
  <p>Both of these are invisible when everything works. Their value shows on the bad day: the day the
  network is out for four hours, the day a delivery and a busy counter collide, the day you move
  someone at short notice. On those days the shop keeps trading and the books still add up &mdash;
  which is the entire promise of an offline-first system, and the part most of them do not finish.</p>
</section>

<!-- ============ 10b. WHAT THE SYSTEM PRINTS ============ -->
<section class="page">
  <h2>What the system prints and exports</h2>
  <p class="lead">Every sample on the next few pages is a photograph of real output from
  this system &mdash; not a drawing of one. They are produced by the same code that runs
  when your cashier presses <b>Print</b>, so what you see here is what your printer will
  produce.</p>

  <p>A pharmacy hands over or files four kinds of document, and PharmaRidge produces all
  four from the same records, so they can never disagree with one another:</p>
  <table>
    <thead><tr><th style="width:26%">Document</th><th style="width:22%">Where it comes from</th><th>What it is for</th></tr></thead>
    <tbody>
      <tr><td><b>Thermal receipt</b></td><td>POS &rarr; Print</td>
          <td>The 80mm roll receipt the customer walks out with. Printed at the counter in a second or two.</td></tr>
      <tr><td><b>A4 receipt</b></td><td>POS &rarr; A4</td>
          <td>The same sale on ordinary paper &mdash; for a company buyer, an HMO, or a customer who needs something to claim against.</td></tr>
      <tr><td><b>Printed report</b></td><td>Any report screen &rarr; Print / PDF</td>
          <td>Stock, sales, expenses, trial balance, P&amp;L. Save it as a PDF from the same dialog to email or file it.</td></tr>
      <tr><td><b>Spreadsheet (CSV)</b></td><td>Any report screen &rarr; CSV</td>
          <td>The same figures for your accountant to work on in Excel or Google Sheets.</td></tr>
    </tbody>
  </table>

  <div class="note"><b>Why there is no &ldquo;Download PDF&rdquo; button.</b> There is a
  <b>Print / PDF</b> button instead, and it does more than a download button would. Every
  device you will use already has a PDF writer built into its print dialog &mdash; on a
  laptop choose <i>Save as PDF</i> as the destination; on Android Chrome the same option
  is in the printer list; on an iPhone, Share &rarr; Print, then share the preview. Going
  through the print dialog means the PDF has <b>real, selectable, searchable text</b> that
  an accountant can copy a figure out of, and the identical document also goes straight to
  paper or to the counter&rsquo;s thermal printer. A bundled PDF library would have added
  roughly 350&nbsp;KB to what every phone in the shop must download and keep offline, and
  would have produced a flat image instead of text.</div>

  ${artefact('70-receipt-thermal.png', 'The thermal receipt &mdash; 80mm roll', `
<p>This is the standard counter receipt, printed on the same 80mm roll every POS printer in
Nigeria uses. It is deliberately plain: no logos to burn through ribbon, no colour, nothing
that a cheap printer will render as a grey smear.</p>
<p>Reading down: your business name and branch, the branch&rsquo;s address, telephone and
<b>PCN licence number</b> &mdash; which is what makes the slip acceptable to an inspector.
Then the receipt number, the date and time, and <b>who served the customer</b>. That last
line matters more than it looks: when a customer returns three weeks later disputing a
price, the receipt names the person who rang it up.</p>
<p>Each line shows the product, the quantity, and the line total, with the unit price and
the <b>batch number</b> printed underneath in smaller type. The batch number is what makes
a recall possible &mdash; if NAFDAC withdraws a batch you can find every customer who was
sold it.</p>
<p>Then the subtotal, the total in bold, and how it was paid. Where a customer pays cash and
the shop cannot make change, a <b>change-owed block</b> is printed at the bottom with a
seven-digit claim code &mdash; explained on the next page.</p>`)}

  ${artefact('74-change-claim-slip.png', 'The change claim slip &mdash; what the customer takes away when you cannot make change', `
<p>Running out of small notes is an ordinary Nigerian trading reality, and the usual answer
&mdash; a sweet, a scribbled IOU, or simply keeping the change &mdash; loses the shop money
and the customer&rsquo;s trust.</p>
<p>PharmaRidge records it instead. The amount owed is booked as a real liability against the
branch, the customer&rsquo;s name or phone number is attached to it, and a
<b>seven-digit claim code</b> is generated and printed. The same block also appears on the
original sale receipt, so the customer has it twice.</p>
<p>The customer can come back and collect the cash, or spend the balance against their next
purchase. <b>If they lose the slip</b> their name or phone number will still find the claim
&mdash; the code is a convenience, not a condition.</p>
<p>Unclaimed change <b>never expires and is never quietly absorbed</b>. It sits on your books
as money you owe until either the customer collects it or you, the owner, deliberately write
it off &mdash; and a write-off is recorded as other income, not as a sale, so it can never
flatter your trading figures.</p>`)}

  ${artefact('71-receipt-a4.png', 'The same sale on A4 &mdash; for a company buyer or an HMO claim', `
<p>The identical sale, rendered for ordinary paper. Use it when a customer needs a document
to claim against: a company account, an HMO reimbursement, a school or clinic buying in bulk.</p>
<p>The layout is a proper table &mdash; item, quantity, unit price, amount &mdash; under your
business name and branch, with the receipt number, date and the member of staff who served
it set out as labelled fields rather than squeezed onto a narrow roll.</p>
<p>Press <b>Print</b> and choose <i>Save as PDF</i> and you have a document you can email.
Because the text is real text and not a picture, the person receiving it can search it, copy
a figure out of it, and file it electronically.</p>`, { wide: true })}

  ${artefact('72-report-print.png', 'A printed report &mdash; stock on hand, valuation and expiry', `
<p>Every report screen in PharmaRidge carries the same <b>Print / PDF</b> and <b>CSV</b>
pair, and both always export exactly what is on the screen &mdash; the same filters, the same
branch, the same date range. You cannot accidentally print one set of figures and export
another.</p>
<p>A printed report is self-describing once it leaves the screen: it carries your business
name, the report title, the period it covers, and who printed it and when. Hand a page to a
bank, an accountant or an inspector and it explains itself without you standing next to it.</p>
<p>Long reports repeat the column headings on every page &mdash; a six-page stock report
where only page one is labelled is unreadable &mdash; and rows are never split across a page
break. Totals are printed in a summary block at the end.</p>`, { wide: true })}

  ${artefact('73-csv-export.png', 'The CSV export, opened in a spreadsheet', `
<p>The same report as a spreadsheet. A PDF is for reading and filing; a spreadsheet is for
reconciling, and your accountant will want the second one.</p>
<p>It opens natively in Excel, Google Sheets, LibreOffice and Numbers with nothing to
install. Row 1 is the header the export writes; every following row is one record.</p>
<p>Two details that are easy to get wrong and cost real money when they are:</p>
<ul>
  <li><b>Negative numbers stay numbers.</b> A loss, a credit balance or a negative stocktake
  variance exports as <i>-50000</i>, not as text. If it exported as text, the
  <code>SUM()</code> your accountant runs down the column would silently skip every loss and
  produce a total that looks right and is wrong.</li>
  <li><b>Naira figures and accented names arrive intact.</b> The file is written with a UTF-8
  marker, without which Excel on Windows mangles every one of them.</li>
</ul>
<p>Anything that could be read as a spreadsheet formula is neutralised on the way out, so a
product name typed as <code>=cmd</code> cannot execute on the machine that opens the file.</p>`,
  { wide: true })}
</section>

<!-- ============ 11. PRICING ============ -->
<section class="page">
  <h2>11. What it costs, and what it saves</h2>
  <p class="lead">PharmaRidge is priced per day, on what you actually run:
  <b>${N(PER_BRANCH_DAY)} per branch per day</b> and <b>${N(PER_STAFF_DAY)} per member of staff per day</b>.</p>
  <table>
    <thead><tr><th>Your pharmacy</th><th>Per day</th><th>Per month</th><th>Per year</th></tr></thead>
    <tbody>${SHAPES.map(([label, p]) => `<tr><td><b>${label}</b></td><td>${N(p.perDay)}</td><td>${N(p.perMonth)}</td><td>${N(p.perYear)}</td></tr>`).join('')}</tbody>
  </table>
  <div class="kpi">
    <div><div class="k">One shop, 2 staff</div><div class="v">${N(plan(1, 2).perDay)}<span style="font-size:9pt;font-weight:400;">/day</span></div></div>
    <div><div class="k">Two shops, 8 staff</div><div class="v">${N(plan(2, 8).perDay)}<span style="font-size:9pt;font-weight:400;">/day</span></div></div>
    <div><div class="k">Five shops, 20 staff</div><div class="v">${N(plan(5, 20).perDay)}<span style="font-size:9pt;font-weight:400;">/day</span></div></div>
  </div>
  <h3>What that means in plain terms</h3>
  <p>A single shop with two staff pays <b>${N(plan(1, 2).perDay)} a day</b> — less than a sachet of
  paracetamol and a bottle of water. A five-branch group with twenty staff pays
  <b>${N(plan(5, 20).perDay)} a day</b>, which is ${N(plan(5, 20).perDay / 5)} per shop.</p>

  <h3>What your plan actually is: capacity you have already bought</h3>
  <p>Your plan is a number of <b>branch slots</b> and a number of <b>staff seats</b>. You have paid for
  them, so they are yours &mdash; whether or not you fill them.</p>
  <ul>
    <li><b>Unused capacity is not wasted money you can claw back; it is room to grow.</b> If you have
      paid for five branches and run three, the other two are already yours: open them whenever you
      are ready, at no extra cost and with no waiting.</li>
    <li><b>You cannot go past what you have paid for.</b> Try to open a sixth branch on a five-branch
      plan and PharmaRidge refuses, and tells you who to contact. That is deliberate &mdash; it stops
      a plan quietly growing into a bill you did not agree to.</li>
    <li><b>Only PharmaRidge can raise the ceiling</b>, because raising it is a purchase. Nobody inside
      your pharmacy &mdash; not even the Owner &mdash; can lift their own limit. The moment support
      raises it, the new capacity is live: no restart, no re-installation.</li>
    <li><b>Closing a shop frees its SLOT, not your money.</b> A deactivated branch releases the slot so
      you can open a different one in its place, and its records stay readable forever. The same is
      true of a staff seat when somebody leaves.</li>
    <li><b>The support account is free.</b> PharmaRidge's own seat is never counted against your staff.</li>
  </ul>
  <div class="note">Your <b>My Plan</b> screen shows this as <b>&ldquo;3 of 5 paid for&rdquo;</b> with
  &ldquo;2 more already paid for and ready to use&rdquo;, so you can always see the capacity you own
  rather than guessing at an allowance.</div>

  <h3>Where the money comes back</h3>
  <p>These are not projections. They are the arithmetic of the leaks described in chapter 1.</p>
  <table>
    <thead><tr><th style="width:46%">One avoided problem</th><th>What it is worth a year</th></tr></thead>
    <tbody>
      <tr><td>One N100 till discrepancy a day, one shop</td><td><b>${N(100 * 365)}</b></td></tr>
      <tr><td>One N100 change claim a day, unrecorded and lost</td><td><b>${N(100 * 365)}</b></td></tr>
      <tr><td>One N15,000 pack expiring unnoticed per branch per month, five shops</td><td><b>${N(15000 * 12 * 5)}</b></td></tr>
      <tr><td>A single N50,000 credit sale to a customer who never returns</td><td><b>${N(50000)}</b></td></tr>
    </tbody>
  </table>
  <p>A five-branch group pays <b>${N(plan(5, 20).perYear)}</b> a year. Preventing expiry write-offs
  alone — one pack per shop per month — covers it nearly twice over.</p>

  <h3>Before you make an upfront payment</h3>
  <div class="note"><b>Decide from evidence, not a promise.</b> Before paying, demonstrate the roles you will use, receive stock into your own test branch, complete a cash and a credit sale, print a receipt, close a till, inspect a report/CSV, test the PWA on the actual phone/printer you intend to use, and agree the commercial/support terms directly with PharmaRidge. The walkthrough and audit evidence show what was tested; they do not replace your own acceptance check, accounting advice, regulatory advice, or a written commercial agreement.</div>

  <h3>Technical support, and what it covers</h3>
  <p>Use the contact details shown on <b>My Plan</b> to agree the support and commercial arrangement for your deployment before payment. The system does enforce several important boundaries itself: the support/admin seat is excluded from staff count and cannot move a branch safe or operate a till as a pharmacy employee.</p>
  <ul>
    <li><b>Bring a reproducible question.</b> Note the role, branch, action and screen involved so the responsible person can review it efficiently.</li>
    <li><b>Agree practical operating terms before paying.</b> Confirm onboarding help, response expectations, printer/PWA compatibility, data export arrangements, subscription timing and any refund/cancellation terms in writing with PharmaRidge.</li>
    <li><b>Keep ownership controls with the Owner.</b> The Owner can control permissions and data-management decisions; support and managers cannot use those controls to silently take cash or erase client data.</li>
  </ul>

  <h3>Billing questions, answered plainly</h3>
  <table>
    <thead><tr><th style="width:36%">Question</th><th>Answer</th></tr></thead>
    <tbody>
      <tr><td><b>What exactly is counted?</b></td>
          <td>Active branches and active staff accounts. A deactivated branch or a retired staff
          account stops counting from the day you deactivate it.</td></tr>
      <tr><td><b>Does the support account cost me?</b></td>
          <td>No. The PharmaRidge support seat is excluded from your staff count.</td></tr>
      <tr><td><b>What if I hire for the festive season?</b></td>
          <td>Add the accounts, pay for the days they exist, retire them in January. There is no
          minimum term on a staff seat and no penalty for removing one.</td></tr>
      <tr><td><b>What if I move a shop instead of closing it?</b></td>
          <td>Relocation keeps the branch and its history; you choose whether the new site carries the
          old stock and books forward or starts fresh. It is the same branch, so it is the same charge.</td></tr>
      <tr><td><b>Is there a charge for the data?</b></td>
          <td>No. Sales, stock, accounting records and the NAFDAC catalogue are all included, and your
          records are exportable to CSV at any time.</td></tr>
    </tbody>
  </table>
</section>

<!-- ============ 12. COMPARISON ============ -->
<section class="page">
  <h2>12. How PharmaRidge differs</h2>
  <p class="lead">Most pharmacy systems in this market fall into three groups. Here is where each one
  hurts, and what PharmaRidge does instead.</p>

  <h3>Against a paper book or a spreadsheet</h3>
  <table>
    <thead><tr><th style="width:33%">Paper / Excel</th><th>PharmaRidge</th></tr></thead>
    <tbody>
      <tr><td>Expiry noticed when a customer points at the box</td><td>Counted daily, warned at 90 days, oldest stock sold first automatically</td></tr>
      <tr><td>Takings reconciled by memory at night</td><td>Expected cash computed continuously; the discrepancy is real when it appears</td></tr>
      <tr><td>Credit written in a notebook</td><td>A limit per customer, enforced at the counter, aged by how old the debt is</td></tr>
      <tr><td>No idea who served a sale</td><td>Every transaction names the person and the minute</td></tr>
      <tr><td>Cannot see the second shop without driving there</td><td>Every branch on one screen, from a phone</td></tr>
    </tbody>
  </table>

  <h3>Against a shop-counter till system</h3>
  <table>
    <thead><tr><th style="width:33%">A generic POS</th><th>PharmaRidge</th></tr></thead>
    <tbody>
      <tr><td>Knows products, not batches — so no expiry and no traceability</td><td>Batch-level stock with expiry, and nearest-expiry-first selling</td></tr>
      <tr><td>No concept of prescription-only or controlled drugs</td><td>Refuses to dispense either without the details PCN expects</td></tr>
      <tr><td>Stops working when the internet does</td><td>Keeps selling offline and syncs when the signal returns</td></tr>
      <tr><td>Change you could not give simply vanishes</td><td>Recorded as a claim with a code, owed to a named person</td></tr>
      <tr><td>Bookkeeping is a separate job at month end</td><td>Double-entry posted as you trade; the books are correct at every moment</td></tr>
    </tbody>
  </table>

  <h3>Against imported pharmacy software</h3>
  <table>
    <thead><tr><th style="width:33%">Foreign systems</th><th>PharmaRidge</th></tr></thead>
    <tbody>
      <tr><td>Licensed per seat, per year, in dollars, paid upfront</td><td>${N(PER_BRANCH_DAY)}/branch/day and ${N(PER_STAFF_DAY)}/staff/day, in naira, only for what you run</td></tr>
      <tr><td>Assumes reliable power and broadband</td><td>Built to keep working when neither holds</td></tr>
      <tr><td>No NAFDAC catalogue, no PCN licence tracking, no PPMV concept</td><td>6,801 NAFDAC-registered products built in; PCN and PPMV licences tracked with expiry warnings</td></tr>
      <tr><td>No withholding tax, or the wrong rates</td><td>The 2024 WHT schedule, both directions, editable by the Owner</td></tr>
      <tr><td>Naira sign prints as a box on thermal receipts</td><td>Money written so it prints correctly on the printers actually in use</td></tr>
      <tr><td>"Contact sales" to add one member of staff</td><td>Add them yourself; the cost adjusts the same day</td></tr>
    </tbody>
  </table>

  <div class="note">
    <b>The honest summary.</b> PharmaRidge is not the cheapest way to ring up a sale — a till drawer and
    a notebook are. It is the cheapest way to stop losing money you are currently losing without
    noticing: expired stock, unexplained till differences, credit that was never collected, and change
    that nobody wrote down.
  </div>
</section>

<section class="page">
  <h2>Getting started</h2>
  <ol>
    <li><b>Change every PIN.</b> The Users screen lists any account still on the demonstration PIN.</li>
    <li><b>Enter your branches</b> with their PCN or PPMV licence numbers and expiry dates.</li>
    <li><b>Add your people</b>, each with the right role. One person, one account.</li>
    <li><b>Put your opening stock in</b> through a purchase order, so every batch has a cost, a price
      and an expiry from day one.</li>
    <li><b>Set your float and your safe.</b> Open the till with the cash actually in the drawer, and
      deposit the reserve into the safe.</li>
    <li><b>Set credit limits</b> for the customers you genuinely extend credit to. Everyone else stays
      cash-only, which is the safe default.</li>
    <li><b>Decide the permission switches</b> — whether managers may void and change prices, and what
      cashiers may correct without you.</li>
  </ol>
  <div class="warn">
    <b>One thing to know before you rely on it.</b> Ask PharmaRidge support to confirm your installation
    has been deployed and tested on live infrastructure with your own data before you switch off your
    old process. Run both for a week. Any system, from any vendor, deserves that week.
  </div>
  <p style="margin-top:24pt;font-size:9.5pt;color:#5b6b64;">
    Every screenshot in this guide was captured from the running application against a demonstration
    pharmacy with eight branches and thirty-five staff. Figures shown are that demonstration data, not
    a real business.
  </p>
  <p style="margin-top:20pt;">
    <img class="mark-inline" src="${iconData}" alt="" /><span style="font-size:10.5pt;color:#0a3b2c;font-weight:600;">PharmaRidge</span>
  </p>
</section>

</body></html>`;

(async () => {
  fs.writeFileSync(OUT_HTML, html);
  const browser = await puppeteer.launch({ headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto('file://' + OUT_HTML, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: OUT_PDF, format: 'A4', printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%;font-size:8pt;color:#8a9a93;padding:0 14mm;
      display:flex;justify-content:space-between;">
      <span>PharmaRidge — Onboarding Guide</span>
      <span class="pageNumber"></span></div>`,
    margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' },
  });
  await browser.close();
  const kb = Math.round(fs.statSync(OUT_PDF).size / 1024);
  console.log(`\nWrote ${OUT_PDF} (${kb} KB)`);
})();
