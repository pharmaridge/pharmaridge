const Exporter = (() => {

  // -------------------------------------------------------------------------
  // Printing
  // -------------------------------------------------------------------------

  // Renders `bodyHtml` into a hidden same-origin iframe and opens the print
  // dialog on it.
  //
  // An iframe rather than window.open(): mobile popup blockers routinely kill
  // window.open() when it isn't a direct user gesture, and on iOS a blocked
  // popup fails SILENTLY — the user taps Print and nothing happens, with no
  // error to react to. An iframe is never blocked.
  //
  // The iframe is same-origin and its content is written by us, so it inherits
  // the page CSP; the stylesheet is pulled from our own origin.
  function printDocument(bodyHtml, { title = 'PharmaRidge', thermal = false } = {}) {
    const existing = document.getElementById('print-frame');
    if (existing) existing.remove();

    const frame = document.createElement('iframe');
    frame.id = 'print-frame';
    // Deliberately not display:none — Safari refuses to print a frame that has
    // no layout box. Positioned off-screen instead so it is rendered but
    // invisible.
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);

    const doc = frame.contentWindow.document;
    doc.open();
    // PAPER IS ALWAYS LIGHT — stated explicitly, not left to luck.
    //
    // This frame links /css/style.css, whose colours are driven by a
    // [data-theme] attribute on <html>. The print frame is a SEPARATE document,
    // so it does not inherit the app's attribute and currently resolves to the
    // light `:root` values — which is the behaviour we want, but only by
    // accident. Anyone later adding `@media (prefers-color-scheme: dark)` to
    // the stylesheet, or copying the attribute onto this frame, would silently
    // start printing dark-grey blocks and white text: unreadable on paper and,
    // on an 80mm thermal roll, a wasted roll per receipt before anyone notices.
    //
    // Pinning data-theme="light" and color-scheme:light here makes the
    // guarantee explicit and survives those edits. Verified by rendering a
    // receipt with the app in dark mode and measuring the computed colours of
    // the body, cards, badges, muted text, stat cards and both styled and
    // UNSTYLED tables: all black-on-white in both themes.
    doc.write(`<!doctype html>
<html lang="en" data-theme="light" style="color-scheme:light"><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/css/style.css"/>
<style>${thermal ? THERMAL_CSS : DOCUMENT_CSS}</style>
</head><body class="${thermal ? 'print-thermal' : 'print-doc'}">${bodyHtml}</body></html>`);
    doc.close();

    // Wait for the stylesheet and any logo image to load, otherwise the first
    // print of a session comes out unstyled. Guarded by a timeout so a slow or
    // failed asset can never leave the user with a button that does nothing.
    let printed = false;
    const go = () => {
      if (printed) return;
      printed = true;
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) {
        if (window.UI) UI.toast('Could not open the print dialog on this device.', 'error');
      }
      // Keep the frame alive briefly: some browsers run print() asynchronously
      // and removing the node too early cancels the job.
      setTimeout(() => { const f = document.getElementById('print-frame'); if (f) f.remove(); }, 60000);
    };

    if (frame.contentWindow.document.readyState === 'complete') setTimeout(go, 250);
    else frame.onload = () => setTimeout(go, 250);
    setTimeout(go, 1500); // hard fallback
  }

  // -------------------------------------------------------------------------
  // Document chrome
  // -------------------------------------------------------------------------

  // Standard letterhead for every printed report: the CLIENT's own business
  // name and logo (white-label), the report title, the period it covers, and
  // who printed it when — so a printed page is self-describing once it has
  // been detached from the screen that produced it.
  function documentHeader(title, subtitle) {
    const b = (window.Branding && Branding.get && Branding.get()) || {};
    const name = (window.Branding && Branding.displayName && Branding.displayName()) || 'PharmaRidge';
    const session = (window.State && State.getSession && State.getSession()) || null;
    const who = session && session.user ? session.user.full_name : '';
    const printedAt = new Date().toLocaleString('en-NG', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    return `
      <div class="print-header">
        <div class="print-brand">
          ${b.has_logo ? `<img src="/api/branding/logo" alt="" class="print-logo"/>` : ''}
          <div>
            <div class="print-business">${escapeHtml(name)}</div>
            <!-- CLIENT INSTRUCTION: pharmacy name bold, "Powered by
                 PharmaRidge" subtle beneath it, on every printed document —
                 receipts, reports, statements. printAttribution() is used
                 rather than poweredByLine() so it is present on an unbranded
                 deployment too. -->
            <div class="print-poweredby">${escapeHtml((window.Branding && Branding.printAttribution && Branding.printAttribution()) || '')}</div>
            ${subtitle ? `<div class="print-sub">${escapeHtml(subtitle)}</div>` : ''}
          </div>
        </div>
        <div class="print-meta">
          <div><strong>${escapeHtml(title)}</strong></div>
          <div>Printed ${escapeHtml(printedAt)}</div>
          ${who ? `<div>By ${escapeHtml(who)}</div>` : ''}
        </div>
      </div>`;
  }

  function documentFooter(note) {
    const poweredBy = (window.Branding && Branding.poweredByLine && Branding.poweredByLine()) || '';
    return `<div class="print-footer">
      ${note ? `<div>${escapeHtml(note)}</div>` : ''}
      ${poweredBy ? `<div>${escapeHtml(poweredBy)}</div>` : ''}
    </div>`;
  }

  // Builds a complete printable report from an array of rows. `columns` is
  // [{ key, label, align, format }]. Everything is escaped.
  // `align` is the ONE value in this builder that lands inside an HTML
  // ATTRIBUTE rather than in text, so escapeHtml is the wrong tool for it —
  // it would happily pass through a crafted value that breaks out of the
  // style attribute. Today every caller passes a developer literal
  // ('right'), so this is a latent hazard rather than a live hole, but a
  // column definition built from a saved report layout or a client
  // customisation would make it real, and it would be invisible in review.
  // Allow-list instead of escaping: only the three CSS keywords a table
  // column can legitimately use.
  const ALIGNMENTS = new Set(['left', 'right', 'center']);
  function alignAttr(align) {
    return ALIGNMENTS.has(align) ? ` style="text-align:${align}"` : '';
  }

  function buildTableReport({ title, subtitle, columns, rows, summary, note, emptyMessage }) {
    const head = columns.map((c) => `<th${alignAttr(c.align)}>${escapeHtml(c.label)}</th>`).join('');
    const body = rows.length
      ? rows.map((r) => `<tr>${columns.map((c) => {
          const raw = c.format ? c.format(r[c.key], r) : r[c.key];
          const text = raw === null || raw === undefined || raw === '' ? '—' : String(raw);
          return `<td${alignAttr(c.align)}>${escapeHtml(text)}</td>`;
        }).join('')}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" style="text-align:center;padding:18px;">${escapeHtml(emptyMessage || 'No records for this selection.')}</td></tr>`;

    const summaryHtml = summary && summary.length
      ? `<table class="print-summary"><tbody>${summary.map((s) =>
          `<tr><th>${escapeHtml(s.label)}</th><td style="text-align:right">${escapeHtml(String(s.value))}</td></tr>`).join('')}</tbody></table>`
      : '';

    return `${documentHeader(title, subtitle)}
      <table class="print-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
      ${summaryHtml}
      <div class="print-count">${rows.length} record${rows.length === 1 ? '' : 's'}</div>
      ${documentFooter(note)}`;
  }

  function printTableReport(opts) {
    printDocument(buildTableReport(opts), { title: opts.title });
  }

  // -------------------------------------------------------------------------
  // CSV / spreadsheet export
  // -------------------------------------------------------------------------

  // CSV FORMULA-INJECTION GUARD.
  //
  // Excel, LibreOffice and Google Sheets treat a cell beginning with = + - @
  // (or tab/CR) as a FORMULA. A product or customer name typed as
  //   =HYPERLINK("http://evil","click")   or   =cmd|'/c calc'!A0
  // becomes executable content the moment the client opens the export. This is
  // a genuine, well-documented attack path out of an otherwise-safe app, and
  // this system lets staff type free-text names all day.
  //
  // Prefixing with an apostrophe forces the spreadsheet to treat the value as
  // text. The apostrophe is not shown as part of the cell value.
  // A value that is genuinely a NUMBER is never a formula, so it must not be
  // text-quoted. This is the difference between a spreadsheet that adds up
  // and one that does not.
  //
  // BUG 48 (reproduced against the real P&L export). The guard below fires on
  // a leading `-`, which is correct for the STRING "-1+1" but catastrophic for
  // the NUMBER -50000: it shipped as '-50000, which Excel, LibreOffice and
  // Google Sheets all read as TEXT. Every loss, every credit balance and every
  // negative stocktake variance therefore left the SUM() an accountant ran
  // over the column — silently, with no error, producing a total that quietly
  // omitted the losses. The Profit & Loss and Balance Sheet CSVs both pass the
  // raw `amount` field, so this hit the two reports that matter most.
  //
  // Restricting the exemption to a real finite `number` keeps the injection
  // guard fully intact: a hostile value arriving as a STRING ("-1+1",
  // "=cmd|...") is still text and still gets the apostrophe. A number cannot
  // carry a formula.
  function isPlainNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (isPlainNumber(value)) return String(value);
    let s = String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    // Escape quotes by doubling, then wrap if the value contains anything the
    // CSV grammar treats as special.
    if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function toCSV(columns, rows) {
    const header = columns.map((c) => csvCell(c.label)).join(',');
    const body = rows.map((r) => columns.map((c) => {
      const raw = c.format ? c.format(r[c.key], r) : r[c.key];
      return csvCell(raw);
    }).join(',')).join('\r\n');
    return `${header}\r\n${body}`;
  }

  // Triggers a browser download of `content`.
  //
  // The UTF-8 BOM matters: without it Excel on Windows decodes the file as
  // Windows-1252, and every Naira figure, accented supplier name and en-dash
  // arrives mojibake. Adding it costs three bytes and fixes the single most
  // common "your export is broken" complaint.
  function download(filename, content, mime = 'text/csv;charset=utf-8;') {
    const withBom = mime.startsWith('text/csv') ? '\ufeff' + content : content;
    const blob = new Blob([withBom], { type: mime });

    // Legacy Edge/IE path, still present on some pharmacy desktop machines.
    if (window.navigator && window.navigator.msSaveOrOpenBlob) {
      window.navigator.msSaveOrOpenBlob(blob, filename);
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Revoke on the next tick, not immediately: Safari cancels an in-flight
    // download if the object URL is revoked synchronously after click().
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function downloadCSV(filename, columns, rows) {
    download(safeFilename(filename, 'csv'), toCSV(columns, rows));
  }

  // Machine-readable export, for a client's accountant or an external system.
  function downloadJSON(filename, data) {
    download(safeFilename(filename, 'json'), JSON.stringify(data, null, 2), 'application/json;charset=utf-8;');
  }

  // Windows/macOS both reject these characters in filenames, and a date suffix
  // stops "sales.csv" overwriting itself every export.
  function safeFilename(base, ext) {
    const stamp = new Date().toISOString().slice(0, 10);
    const clean = String(base).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return `${clean}-${stamp}.${ext}`;
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  // Renders a consistent Print / CSV toolbar. Screens call this instead of
  // hand-rolling buttons, so every report exports the same way.
  //
  // `id` must be unique per screen; handlers are attached by wireToolbar().
  function toolbar(id, { csv = true, json = false, label = 'this report' } = {}) {
    return `<div class="export-toolbar no-print" data-export-toolbar="${escapeHtml(id)}">
      <button class="btn btn-secondary btn-sm" data-export="print" title="Print ${escapeHtml(label)}, or save it as a PDF from the print dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M6 16h12v5H6z"/></svg>Print / PDF</button>
      ${csv ? `<button class="btn btn-secondary btn-sm" data-export="csv" title="Download ${escapeHtml(label)} as a spreadsheet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M12 3v11M8 11l4 4 4-4M4 19h16"/></svg>CSV</button>` : ''}
      ${json ? `<button class="btn btn-secondary btn-sm" data-export="json" title="Download raw data"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="15" height="15" style="vertical-align:-2px;margin-right:5px;"><path d="M12 3v11M8 11l4 4 4-4M4 19h16"/></svg>JSON</button>` : ''}
    </div>`;
  }

  function wireToolbar(id, handlers) {
    const el = document.querySelector(`[data-export-toolbar="${id}"]`);
    if (!el) return;
    el.querySelectorAll('[data-export]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.export;
        try {
          if (kind === 'print' && handlers.print) handlers.print();
          else if (kind === 'csv' && handlers.csv) handlers.csv();
          else if (kind === 'json' && handlers.json) handlers.json();
        } catch (e) {
          if (window.UI) UI.toast(`Export failed: ${e.message}`, 'error');
        }
      });
    });
  }

  // Convenience: one call wires a standard table report to both buttons, so a
  // screen cannot accidentally print one set of columns and export another.
  function wireTableReport(id, opts) {
    wireToolbar(id, {
      print: () => printTableReport(opts),
      csv: () => downloadCSV(opts.filename || opts.title, opts.columns, opts.rows),
    });
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // -------------------------------------------------------------------------
  // Print stylesheets (inlined into the print frame)
  // -------------------------------------------------------------------------

  // A4 document: reports, statements, financial records.
  const DOCUMENT_CSS = `
    @page { size: A4; margin: 14mm 12mm; }
    body.print-doc { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 11px; color: #111; background: #fff; margin: 0; }
    .print-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #0b3d2e; padding-bottom: 8px; margin-bottom: 12px; }
    .print-brand { display: flex; gap: 10px; align-items: center; }
    .print-logo { max-height: 44px; max-width: 120px; object-fit: contain; }
    .print-business { font-size: 17px; font-weight: 700; color: #0b3d2e; }
    /* Subtle by design: it must never compete with the pharmacy's own name. */
    .print-poweredby { font-size: 8.5px; color: #7b8a84; letter-spacing: .3px; margin-top: 1px; }
    .print-sub { font-size: 11px; color: #555; }
    .print-meta { text-align: right; font-size: 10px; color: #444; line-height: 1.5; }
    .print-meta strong { font-size: 13px; color: #111; }
    table.print-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    table.print-table th { background: #eef3f1; border: 1px solid #b9ccc5; padding: 5px 6px; text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .3px; }
    table.print-table td { border: 1px solid #d7e2de; padding: 4px 6px; }
    /* Repeat the header row on every printed page — a 6-page stock report is
       unreadable if only page 1 has column labels. */
    table.print-table thead { display: table-header-group; }
    table.print-table tr { page-break-inside: avoid; }
    table.print-summary { border-collapse: collapse; margin: 8px 0 0 auto; min-width: 240px; }
    table.print-summary th { text-align: left; padding: 4px 10px; border-top: 1px solid #d7e2de; font-size: 11px; }
    table.print-summary td { padding: 4px 10px; border-top: 1px solid #d7e2de; font-weight: 700; }
    .print-count { font-size: 10px; color: #666; margin-top: 6px; }
    .print-footer { margin-top: 14px; padding-top: 6px; border-top: 1px solid #ccc; font-size: 9px; color: #666; display: flex; justify-content: space-between; }
    .print-section { margin-top: 14px; page-break-inside: avoid; }
    .print-section h3 { font-size: 12px; margin: 0 0 6px; color: #0b3d2e; border-bottom: 1px solid #d7e2de; padding-bottom: 3px; }
    .no-print { display: none !important; }
  `;

  // 80mm thermal receipt roll — the standard pharmacy counter printer. Also
  // prints acceptably to A4 if that is all the branch has.
  const THERMAL_CSS = `
    @page { size: 80mm auto; margin: 3mm; }
    body.print-thermal { font-family: "Courier New", monospace; font-size: 11px; color: #000; background: #fff; margin: 0; width: 74mm; }
    .r-center { text-align: center; }
    .r-business { font-size: 14px; font-weight: 700; }
    /* Subtle beneath the shop's name. 8px is the smallest a 203dpi thermal
       head renders reliably; below that it prints as a grey smudge. */
    .r-poweredby { font-size: 8px; color: #444; letter-spacing: .2px; }
    .r-line { display: flex; justify-content: space-between; gap: 6px; }
    /* BUG 105 — TEXT SILENTLY CUT OFF THE EDGE OF THE THERMAL ROLL.
       This was .r-line span:last-child { white-space: nowrap }, intended to
       stop a MONEY amount wrapping away from its label. But a receipt line
       whose right-hand cell is EMPTY — which is how every full-width
       instruction is emitted, L(text, '') — makes the FIRST span the
       :last-child as well, so the long text inherited nowrap and ran straight
       off the paper. Printed to a real 80mm roll, the change-claim
       instruction stopped mid-word at "...or use i": the customer holding a
       claim never reads how to collect their money.
       Targeting the second span POSITIONALLY keeps the money-amount
       protection exactly as intended and can never apply to a lone cell.
       min-width:0 lets the text cell actually shrink and wrap inside flex. */
    .r-line > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .r-line > span:nth-child(2) { white-space: nowrap; }
    .r-rule { border-top: 1px dashed #000; margin: 4px 0; }
    .r-total { font-size: 13px; font-weight: 700; }
    .r-small { font-size: 9px; }
    .r-logo { max-width: 40mm; max-height: 18mm; object-fit: contain; }
    .no-print { display: none !important; }
  `;

  return {
    printDocument, printTableReport, buildTableReport,
    documentHeader, documentFooter,
    toCSV, csvCell, download, downloadCSV, downloadJSON, safeFilename,
    toolbar, wireToolbar, wireTableReport,
    escapeHtml,
  };
})();

// BUG 111 — `window.Exporter` IS UNDEFINED, AND CALLERS FEATURE-DETECT ON IT.
//
// A top-level `const` creates a binding in the script scope, NOT a property on
// `window`. Several modules guard optional access as
// `(window.Exporter && Exporter.thing())` — a reasonable-looking defensive idiom that
// is in fact ALWAYS FALSE here, so the guarded branch never runs and the
// fallback is taken silently and forever.
//
// What that actually cost: every receipt and every printed report showed
// "PharmaRidge" as the letterhead instead of the client's own pharmacy name,
// on every white-labelled deployment, since day one. Nothing errored — the
// fallback was a legitimate-looking default.
//
// Publishing the module on `window` makes those guards true and keeps them
// honest as guards (a module genuinely not loaded is still falsy). Assigning
// here rather than rewriting ~11 call sites is deliberate: the next such
// guard someone writes will also work.
window.Exporter = Exporter;
