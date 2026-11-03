/* VIEW 6 · WHATSAPP TEMPLATES (approved fee-reminder templates in AiSensy) */
import { api } from '../api.js';
import { esc, nf } from '../format.js';
import { $, chip } from '../ui.js';

// The templates' variables, in order: {{1}} amount, {{2}} student, {{3}} due date (settings.aisensy_template_params).
const TOKENS = ['amount_due', 'student_name', 'due_date'];
let cache = null;   // the server's answer, shared with the campaign preview

/** {templates:[{name,status,category,header,body,footer,buttons}], rules:[[days,name]], test_mode, test_to, test_limit} */
export function loadWaTemplates() {
  if (!cache) cache = api.whatsappTemplates().catch((e) => { cache = null; throw e; });
  return cache;
}

export const statusChip = (st) => (st === 'APPROVED' ? chip('Approved', 'green')
  : st === 'UNKNOWN' ? chip('Not found in AiSensy', 'red') : chip('Pending approval', 'amber', 'WhatsApp has not approved this template yet; it cannot be sent'));

/** The template as a WhatsApp bubble; `values` fills {{n}} (missing ones show as violet tokens). */
export function waBubble(t, values = {}) {
  const fill = (txt) => esc(txt || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const k = TOKENS[+n - 1] || `var_${n}`;
    return values[k] != null ? `<b>${esc(values[k])}</b>` : `<span class="tok">{${k}}</span>`;
  }).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  const btns = (t.buttons || []).map((b) => `<div class="border-top p-2 text-center fw-semibold text-blue">${b.type === 'URL' ? '🔗 ' : ''}${esc(b.text)}</div>`).join('');
  return `<div class="bubble"><div class="p-3">${t.header ? `<b>${esc(t.header)}</b><br>` : ''}${fill(t.body) || '<span class="text-muted-2">Template text not available</span>'}`
    + `${t.footer ? `<div class="fs-8 text-muted-2 mt-2">${esc(t.footer)}</div>` : ''}</div>${btns}</div>`;
}

/** When the "Recommended by due date" choice uses this template, in words. */
function whenUsed(name, rules) {
  const i = rules.findIndex(([, n]) => n === name);
  if (i < 0) return 'Pick it by hand in the send step';
  const hi = rules[i][0], lo = i ? rules[i - 1][0] + 1 : null;
  const day = (d) => (d < 0 ? `${nf(-d)} day${d === -1 ? '' : 's'} overdue` : d === 0 ? 'due today' : `${nf(d)} day${d === 1 ? '' : 's'} before`);
  if (lo == null) return `Recommended when the fee is more than ${nf(-hi - 1)} days overdue`;
  if (hi >= 9999) return `Recommended ${nf(lo)} or more days before the due date`;
  return lo === hi ? `Recommended ${day(hi)}` : `Recommended ${day(lo)} – ${day(hi)}`;
}

export async function renderTemplates() {
  const box = $('#tplGrid');
  box.innerHTML = '<div class="text-muted-2">Loading templates from AiSensy…</div>';
  try {
    const r = await loadWaTemplates();
    const ok = r.templates.filter((t) => t.status === 'APPROVED').length;
    $('#tplSummary').textContent = `${nf(r.templates.length)} fee-reminder templates · ${nf(ok)} approved · {{1}} amount, {{2}} student name, {{3}} due date · Pay Now opens the student's own payment link`;
    box.innerHTML = r.templates.map((t) => `<div class="col"><div class="card h-100"><div class="card-body d-flex flex-column gap-2">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2"><h2 class="card-title m-0 fs-6 text-break">${esc(t.name)}</h2>${statusChip(t.status)}</div>
        <div class="fs-8 text-muted-2">${esc([t.category, t.language].filter(Boolean).join(' · '))}${t.category ? ' · ' : ''}${esc(whenUsed(t.name, r.rules))}</div>
        <div class="phone" style="min-height:0">${waBubble(t)}</div>
      </div></div></div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="text-danger">${esc(err.message || 'Could not load the templates')}</div>`;
  }
}
