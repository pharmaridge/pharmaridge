// Builds a polished PDF companion to DEPLOY-MULTI-CLIENT-SSH-CLOUDFLARE-WINDOWS.md.
// The Markdown remains the copy/paste terminal source; this PDF is the
// professional review/print version for deployment operators.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..', '..');
const INPUT = path.join(ROOT, 'DEPLOY-MULTI-CLIENT-SSH-CLOUDFLARE-WINDOWS.md');
const OUTPUT = path.join(ROOT, 'docs', 'PharmaRidge-Multi-Client-Windows-Deployment.pdf');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function inline(value) {
  let s = esc(value);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((v) => v.trim());
}
function isTableRule(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r/g, '').split('\n');
  let out = '';
  let i = 0;
  let list = null;
  function closeList() { if (list) { out += `</${list}>`; list = null; } }
  function paragraph(text) { if (text.trim()) out += `<p>${inline(text)}</p>`; }

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      const block = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) block.push(lines[i++]);
      out += `<pre><code>${esc(block.join('\n'))}</code></pre>`;
      i++;
      continue;
    }
    if (i + 1 < lines.length && line.includes('|') && isTableRule(lines[i + 1])) {
      closeList();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out += '<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      out += rows.map((row) => `<tr>${head.map((_, n) => `<td>${inline(row[n] || '')}</td>`).join('')}</tr>`).join('');
      out += '</tbody></table></div>';
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      out += `<h${level}>${inline(h[2])}</h${level}>`;
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      closeList(); out += '<hr/>'; i++; continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out += `<aside>${quote.map(inline).join('<br/>')}</aside>`;
      continue;
    }
    const ul = /^[-*]\s+(.+)$/.exec(line);
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ul || ol) {
      const wanted = ul ? 'ul' : 'ol';
      if (list && list !== wanted) closeList();
      if (!list) { out += `<${wanted}>`; list = wanted; }
      out += `<li>${inline((ul || ol)[1])}</li>`;
      i++;
      continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+\.\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^---\s*$/.test(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) break;
      para.push(lines[i++]);
    }
    paragraph(para.join(' '));
  }
  closeList();
  return out;
}

(async () => {
  const markdown = fs.readFileSync(INPUT, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 15mm 14mm 17mm; }
    * { box-sizing: border-box; }
    body { font-family: "Segoe UI", Arial, sans-serif; color:#183229; font-size:10.2pt; line-height:1.52; margin:0; }
    h1 { color:#0a3b2c; font-size:27pt; letter-spacing:-.5pt; margin:0 0 10pt; }
    h2 { color:#0a3b2c; font-size:17pt; border-bottom:2pt solid #1a7a52; padding-bottom:5pt; margin:24pt 0 10pt; break-after:avoid; }
    h3 { color:#145c3f; font-size:12pt; margin:16pt 0 6pt; break-after:avoid; }
    p { margin:0 0 8pt; }
    ul,ol { padding-left:18pt; margin:0 0 10pt; }
    li { margin-bottom:4pt; }
    code { font-family:Consolas,"Courier New",monospace; font-size:8.5pt; background:#edf4ef; border-radius:2pt; padding:1pt 3pt; overflow-wrap:anywhere; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#092f23; color:#eaf7f0; border-radius:5pt; padding:10pt; margin:8pt 0 12pt; font:8.2pt/1.45 Consolas,"Courier New",monospace; page-break-inside:avoid; }
    pre code { background:transparent; color:inherit; padding:0; font:inherit; }
    aside { background:#fdf6ec; border-left:3pt solid #d98c1f; padding:8pt 10pt; margin:10pt 0; page-break-inside:avoid; }
    .table-wrap { overflow:hidden; margin:8pt 0 12pt; page-break-inside:avoid; }
    table { border-collapse:collapse; width:100%; font-size:8.5pt; }
    th { background:#0a3b2c; color:#fff; text-align:left; padding:5pt; }
    td { border:1px solid #d8e2dc; vertical-align:top; padding:5pt; }
    tr:nth-child(even) td { background:#f6faf7; }
    hr { border:0; border-top:1pt solid #d8e2dc; margin:18pt 0; }
    .cover { min-height:245mm; display:flex; flex-direction:column; justify-content:center; padding:20mm 10mm; background:linear-gradient(145deg,#eaf7f0,#fff); border:1pt solid #cfe2d7; }
    .cover .eyebrow { color:#1a7a52; font-weight:700; letter-spacing:.11em; text-transform:uppercase; font-size:9pt; }
    .cover .sub { color:#48665a; font-size:13pt; max-width:120mm; }
    .cover .note { margin-top:30mm; color:#5a665f; font-size:9pt; }
    .pagebreak { break-before:page; }
  </style></head><body>
    <section class="cover"><div class="eyebrow">PharmaRidge deployment runbook</div><h1>One Windows laptop.<br/>Many client accounts.<br/>No crossed wires.</h1><p class="sub">Terminal-first Git SSH, Cloudflare account isolation, new D1 databases, and Admin-first client onboarding.</p><p class="note">Use the Markdown file for copy/paste commands. Use this PDF to review the operating sequence with a deployment team.</p></section>
    <main class="pagebreak">${markdownToHtml(markdown.replace(/^# PharmaRidge: Multi-Client Deployment from One Windows Laptop\n/, ''))}</main>
  </body></html>`;
  fs.mkdirSync(path.dirname(OUTPUT), { recursive:true });
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil:'load' });
    await page.pdf({ path:OUTPUT, format:'A4', printBackground:true, margin:{ top:'15mm', right:'14mm', bottom:'17mm', left:'14mm' } });
  } finally { await browser.close(); }
  console.log(`Wrote ${OUTPUT}`);
})().catch((err) => { console.error(err); process.exit(1); });
