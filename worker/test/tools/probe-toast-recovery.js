// ERROR TOAST RECOVERY PROBE — every red browser toast must name a next step.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="toast-container"></div></body></html>', { runScripts: 'outside-only' });
dom.window.eval(fs.readFileSync(require('path').join(__dirname, '../../../public/js/ui.js'), 'utf8'));
const UI = dom.window.UI;
let pass = 0; let fail = 0;
function check(label, yes, detail) { if (yes) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label} — ${detail || ''}`); } }
const samples = [
  ['A required value is missing', 'Complete the highlighted field'],
  ['You do not have permission for this action', 'required role'],
  ['Open till session blocks this action', 'Close or resolve'],
  ['Network connection failed', 'Check the connection'],
  ['Unexpected server response', 'Review the message'],
];
for (const [message, expected] of samples) {
  UI.toast(message, 'error', 60000);
  const toast = dom.window.document.querySelector('#toast-container .toast:last-child');
  check(`error toast contains recovery reference for “${message}”`, !!toast && /^What to do:/.test(toast.querySelector('.toast-recovery').textContent) && toast.textContent.includes(expected), toast && toast.textContent);
}
UI.toast('Saved', 'success', 60000);
check('success toast does not receive an irrelevant recovery reference', !dom.window.document.querySelector('#toast-container .toast:last-child .toast-recovery'), 'success contained recovery');
console.log(`\nERROR TOAST RECOVERY PROBE: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
