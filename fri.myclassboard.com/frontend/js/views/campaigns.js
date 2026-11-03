/* VIEW 5 · CAMPAIGN STUDIO */
import { D, S, rawInst } from '../store.js';
import { api } from '../api.js';
import { loadWaTemplates, waBubble } from './templates.js';
import { esc, nf, sum, rupees } from '../format.js';
import { locked } from '../metrics.js';
import { $, $$, toast, busy, showModal, chip } from '../ui.js';

const CH = [['app', 'App push', 'MCB parent app · no per-message cost'], ['wa', 'WhatsApp', 'Approved utility template'], ['sms', 'SMS', 'DLT-registered template · institute sender ID']];
const CAD = [['t7', '7 days before', 'Gentle heads-up'], ['t3', '3 days before', 'Reminder'], ['t1', '1 day before', 'Last call'], ['d0', 'Due date', 'Morning nudge'], ['p3', '3 days after', 'Overdue'], ['p7', '7 days after', 'Escalate to institute']];

// Students with unpaid fees due this financial year, per selected school, from its fee search index: the pop-up's list,
// narrowed by the "Which parents" choices and the due month (`key`; counts are dropped when it changes).
const DUE = { counts: new Map(), pending: new Set(), key: '' };
const AUD_FILTERS = ['due_7d', 'partially_paid'];   // the choices the fee index can answer
const FILTER_TEXT = { due_7d: 'due in the next 7 days', partially_paid: 'partially paid' };
/** The campaign's audience choices: months = ticked fee due months (yyyy-mm; [] = the whole year), filters = "Which parents". */
function audience() {
  return { months: $$('#pfMonths input:checked').map((i) => i.value),
    filters: $$('#parentFilters input:checked').map((i) => i.value).filter((v) => AUD_FILTERS.includes(v)) };
}
const audKey = (a) => a.months.join(',') + '|' + a.filters.join(',');
/** The instalments a campaign is about (same rule as feesearch.pick_dues): the months, then any chosen filter. */
function pickDues(s, today, a) {
  const dues = a.months.length ? s.dues.filter((d) => a.months.includes(monthKey(d[0]))) : s.dues;
  if (!a.filters.length) return dues;
  return dues.filter((d) => (a.filters.includes('due_7d') && d[0] && daysTo(d[0], today) >= 0 && daysTo(d[0], today) <= 7)
    || (a.filters.includes('partially_paid') && d[2]));
}
const audText = (a) => [a.filters.map((f) => FILTER_TEXT[f]).join(' or '),
  a.months.length ? `due in ${a.months.map(monthName).join(', ')}` : ''].filter(Boolean).join(', ');

/** The financial year's months (Apr–Mar) as tick buttons for the campaign's fee due months. */
function fillAudMonths() {
  const el = $('#pfMonths');
  if (!el || el.children.length) return;
  const now = new Date(), fy = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const ms = Array.from({ length: 12 }, (_, i) => { const y = fy + (i >= 9 ? 1 : 0), m = ((i + 3) % 12) + 1; return `${y}-${String(m).padStart(2, '0')}`; });
  el.innerHTML = ms.map((m) => `<input type="checkbox" class="btn-check" id="pfm-${m}" value="${m}"><label class="pill" for="pfm-${m}">${esc(monthName(m))}</label>`).join('');
}
// Total students per selected school: active students in its current academic year, from the student search index.
const TOT = { counts: new Map(), pending: new Set() };

/** Fetch due-student counts for selected schools not loaded yet, then repaint the column and the total. */
function loadDue(ids) {
  const a = audience(), key = audKey(a);
  if (key !== DUE.key) { DUE.key = key; DUE.counts.clear(); DUE.pending.clear(); }
  const todo = ids.filter((id) => !DUE.counts.has(id) && !DUE.pending.has(id));
  for (let i = 0; i < todo.length; i += 3) {     // small batches: a large school's first count can take ~40 s
    const part = todo.slice(i, i + 3);
    part.forEach((id) => DUE.pending.add(id));
    api.dueStudents(part, a.months.join(','), a.filters).then((r) => { if (DUE.key === key) part.forEach((id) => DUE.counts.set(id, r.schools[id] ?? null)); })
      .catch(() => { if (DUE.key === key) part.forEach((id) => DUE.counts.set(id, null)); })
      .finally(() => { if (DUE.key === key) { part.forEach((id) => DUE.pending.delete(id)); paintDue(); } });
  }
  const tot = ids.filter((id) => !TOT.counts.has(id) && !TOT.pending.has(id));
  for (let i = 0; i < tot.length; i += 25) {
    const part = tot.slice(i, i + 25);
    part.forEach((id) => TOT.pending.add(id));
    api.studentTotals(part).then((r) => part.forEach((id) => TOT.counts.set(id, r.schools[id] ?? null)))
      .catch(() => part.forEach((id) => TOT.counts.set(id, null)))
      .finally(() => { part.forEach((id) => TOT.pending.delete(id)); paintDue(); });
  }
  paintDue();
}

function paintDue() {
  const ids = chosen().map((x) => x.id);
  $$('#audRows [data-total]').forEach((el) => {
    const id = el.dataset.total;
    const v = TOT.counts.get(id);
    el.textContent = !ids.includes(id) ? '' : TOT.pending.has(id) || v === undefined ? '…' : v === null ? 'n/a' : nf(v);
    el.title = ids.includes(id) ? "Active students in the school's current academic year (student search index)" : '';
  });
  $$('#audRows [data-due]').forEach((el) => {
    const id = el.dataset.due;
    if (!ids.includes(id)) { el.textContent = ''; el.title = ''; return; }
    const v = DUE.counts.get(id);
    const n = DUE.pending.has(id) || v === undefined ? '…' : v === null ? 'n/a' : nf(v);
    el.innerHTML = v ? `<a href="#" class="fw-semibold" data-due-list="${esc(id)}">${n}</a>` : n;
    el.title = v === null ? "This school has no fee search index, so its fee dues cannot be read" : v ? 'Show these students' : '';
  });
  const done = ids.filter((id) => DUE.counts.has(id) && !DUE.pending.has(id));
  const known = done.filter((id) => DUE.counts.get(id) !== null);
  const total = sum(known.map((id) => DUE.counts.get(id)));
  const at = audText(audience());
  $('#dueSummary').innerHTML = !ids.length ? 'Select institutes to see how many students have unpaid fees due this financial year.'
    : `<b class="text-violet">${nf(total)}</b> student${total === 1 ? '' : 's'} with unpaid fees due this financial year${at ? ' · ' + esc(at) : ''} at ${nf(known.length)} selected institute${known.length === 1 ? '' : 's'}`
      + (done.length < ids.length ? ` · counting ${nf(ids.length - done.length)} more…` : '')
      + (done.length > known.length ? ` · ${nf(done.length - known.length)} could not be counted` : '');
}

const dueDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/** Pop-up: one school's students with unpaid fees — student, amount due, due date — by branch and due month. */
const DL = { r: null, id: '', name: '', sel: new Set(), shown: [] };   // the list; ticked students (index in r.students); rows on screen
const monthKey = (iso) => (iso ? iso.slice(0, 7) : 'none');
const monthName = (k) => (k === 'none' ? 'No due date' : new Date(k + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }));

async function showDueList(id) {
  const x = rawInst(id) || D.inst.institutes.find((y) => y.id === id) || { name: id };
  DL.r = null; DL.id = id; DL.name = x.name; DL.sel = new Set(); DL.shown = [];
  $('#dueSel').textContent = '';
  $('#dueTitle').textContent = x.name;
  $('#dueSub').textContent = 'Loading students with unpaid fees…';
  $('#dueFilters').hidden = true;
  $('#dueTable').innerHTML = '<tbody><tr><td class="text-center text-muted-2 py-4">Loading…</td></tr></tbody>';
  sendMode(false);
  showModal($('#dueModal'));
  loadTemplates().catch(() => {});
  try {
    const r = await api.dueList(id);
    DL.r = r; DL.name = r.institute || x.name;
    $('#dueTitle').textContent = DL.name;
    const branches = [...new Set(r.students.map((s) => s.branch).filter(Boolean))].sort();
    const withPg = branches.filter((b) => branchPg(b)?.length).length, noPg = branches.filter((b) => branchPg(b)?.length === 0).length;
    const months = [...new Set(r.students.flatMap((s) => s.dues.map((d) => monthKey(d[0]))))].sort((p, q) => (p === 'none') - (q === 'none') || p.localeCompare(q));
    $('#dueBranch').innerHTML = `<option value="">All branches (${nf(branches.length)})</option>`
      + `<option value="@pg">Branches with PG (${nf(withPg)})</option><option value="@nopg">Branches with no PG (${nf(noPg)})</option>`;
    $('#dueMonth').innerHTML = '<option value="">All months</option>' + months.map((m) => `<option value="${m}">${esc(monthName(m))}</option>`).join('');
    const am = audience().months;
    if (am.length === 1 && months.includes(am[0])) $('#dueMonth').value = am[0];   // open on the campaign's due month
    $('#dueFilters').hidden = false;
    paintDueList();
  } catch (err) {
    $('#dueSub').textContent = '';
    $('#dueTable').innerHTML = `<tbody><tr><td class="text-center text-danger py-4">${esc(err.message || 'Could not load the students')}</td></tr></tbody>`;
  }
}

/** The branch's payment gateways ([] = no PG), or undefined when the gateway mapping has no row for it. */
const branchPg = (b) => DL.r?.branch_pg?.[(b || '').trim().toLowerCase()];
const branchPick = (branch) => (s) => !branch || (branch === '@pg' ? !!branchPg(s.branch)?.length : branchPg(s.branch)?.length === 0);
const branchText = (branch) => (branch === '@pg' ? 'branches with PG' : 'branches with no PG');

/** Repaint the pop-up for the chosen branch and due month; amounts, dates and instalment counts follow the month. */
function paintDueList() {
  const r = DL.r;
  if (!r) return;
  const branch = $('#dueBranch').value, month = $('#dueMonth').value;
  const camp = audience();   // "Which parents" and months from the campaign; a month picked here narrows to that one
  const a = { months: month ? [month] : camp.months, filters: camp.filters };
  const rows = r.students.map((s, i) => [s, i]).filter(([s]) => branchPick(branch)(s)).map(([s, i]) => {
    const dues = pickDues(s, r.today, a);
    const dated = dues.map((d) => d[0]).filter(Boolean).sort();
    return { ...s, i, amount: sum(dues.map((d) => d[1])), items: dues.length, due_date: dated[0] || null };
  }).filter((s) => s.items > 0)
    .sort((p, q) => (!p.due_date) - (!q.due_date) || (p.due_date || '').localeCompare(q.due_date || '') || q.amount - p.amount);
  const total = sum(rows.map((s) => s.amount));
  const late = rows.filter((s) => s.due_date && s.due_date < r.today).length;
  $('#dueSub').textContent = `FY ${r.fy} · ${nf(rows.length)} student${rows.length === 1 ? '' : 's'} with unpaid fees`
    + (a.filters.length ? ` · ${a.filters.map((f) => FILTER_TEXT[f]).join(' or ')}` : '')
    + (a.months.length ? ` due in ${a.months.map(monthName).join(', ')}` : '') + (branch ? ` at ${branchText(branch)}` : '')
    + ` · ${rupees(total)} due` + (late ? ` · ${nf(late)} overdue` : '') + ' · earliest due date first';
  DL.shown = rows;
  $('#dueTable').innerHTML = `<thead><tr><th scope="col" style="width:2rem"><input class="form-check-input" type="checkbox" id="dueAll" aria-label="Select all students shown"${rows.length ? '' : ' disabled'}></th>`
    + `<th scope="col">School name</th><th scope="col">Student name</th><th scope="col" class="text-end">Due amount</th><th scope="col" class="text-end">Due date</th></tr></thead><tbody>`
    + (rows.map((s) => `<tr><td><input class="form-check-input" type="checkbox" data-due-pick="${s.i}" aria-label="Select ${esc(s.name)}"${DL.sel.has(s.i) ? ' checked' : ''}></td><td>${esc(DL.name)}${s.branch ? `<div class="fs-8 text-muted-2">${esc(s.branch)}${branchPg(s.branch) ? ` · ${branchPg(s.branch).length ? 'PG' : 'No PG'}` : ''}</div>` : ''}</td>`
      + `<td><span class="fw-semibold">${esc(s.name)}</span>${s.cls || s.code ? `<div class="fs-8 text-muted-2">${esc([s.cls, s.code].filter(Boolean).join(' · '))}</div>` : ''}</td>`
      + `<td class="text-end tnum">${rupees(s.amount)}</td><td class="text-end text-nowrap ${s.due_date && s.due_date < r.today ? 'text-danger fw-semibold' : ''}">${s.due_date ? dueDay(s.due_date) : '—'}${s.items > 1 ? `<div class="fs-8 text-muted-2 fw-normal">${nf(s.items)} instalments</div>` : ''}</td></tr>`).join('')
      || '<tr><td colspan="5" class="text-center text-muted-2 py-4">No unpaid fees for this branch and month.</td></tr>')
    + '</tbody>';
  paintDueSel();
}

/** Header tick (all / some / none of the rows shown) and the selected count in the footer. */
function paintDueSel() {
  const r = DL.r;
  if (!r) return;
  const on = DL.shown.filter((s) => DL.sel.has(s.i)).length;
  const all = $('#dueAll');
  if (all) { all.checked = on > 0 && on === DL.shown.length; all.indeterminate = on > 0 && on < DL.shown.length; }
  const picked = [...DL.sel].map((i) => r.students[i]);
  $('#dueWa').disabled = !picked.length;
  $('#dueWa').textContent = picked.length ? `Send message (${nf(picked.length)})` : 'Send message';
  $('#dueSel').textContent = picked.length ? `${nf(picked.length)} student${picked.length === 1 ? '' : 's'} selected · ${rupees(sum(picked.map((s) => s.amount)))} due in FY ${r.fy}` : '';
}

/** WhatsApp fee reminder to the parents of the ticked students (the chosen due month only, when one is picked). */
/* ---------- Send step: template per student (recommended by due date) or one template for all ---------- */
const TPL = { r: null, p: null };   // {templates:[{name,status,body,header}], rules:[[days,name]], test_mode, test_to, test_limit}
function loadTemplates() {
  return loadWaTemplates().then((r) => { TPL.r = r; return r; });
}
const daysTo = (iso, today) => Math.round((new Date(iso + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
/** The template the due-date rules give for an earliest due date (same rule as the server). */
function recommend(iso) {
  const rules = TPL.r.rules;
  if (!iso) return rules[rules.length - 1][1];
  const d = daysTo(iso, DL.r.today);
  return (rules.find(([n]) => d <= n) || rules[rules.length - 1])[1];
}
const whenText = (iso) => {
  if (!iso) return 'no due date';
  const d = daysTo(iso, DL.r.today);
  return d < 0 ? `${nf(-d)} day${d === -1 ? '' : 's'} overdue` : d === 0 ? 'due today' : `due in ${nf(d)} day${d === 1 ? '' : 's'}`;
};
const tplInfo = (name) => TPL.r.templates.find((t) => t.name === name) || { name, status: 'UNKNOWN', body: '' };
const tplOk = (name) => tplInfo(name).status === 'APPROVED';
const statusChip = (name) => { const st = tplInfo(name).status; return st === 'APPROVED' ? chip('Approved', 'green') : chip(st === 'UNKNOWN' ? 'Not found' : 'Pending approval', 'amber', 'WhatsApp has not approved this template yet; it cannot be sent'); };

/** The ticked students with this month's dues (when a month is chosen): amount, earliest date, recommended template. */
function sendRows() {
  const camp = audience(), m = $('#dueMonth').value;
  const a = { months: m ? [m] : camp.months, filters: camp.filters };
  return [...DL.sel].map((i) => DL.r.students[i]).map((s) => {
    const dues = pickDues(s, DL.r.today, a);
    const first = dues.map((d) => d[0]).filter(Boolean).sort()[0] || null;
    return { s, amount: sum(dues.map((d) => d[1])), first, rec: recommend(first), items: dues.length };
  }).filter((x) => x.items > 0);
}

function paintSend() {
  const rows = sendRows();
  const pick = $('#dueTplPick')?.value ?? '';
  const use = (x) => pick || x.rec;
  const groups = new Map();
  rows.forEach((x) => groups.set(use(x), [...(groups.get(use(x)) || []), x]));
  const blocked = rows.filter((x) => !tplOk(use(x))).length;
  const r = TPL.r;
  $('#dueSend').innerHTML = `<h3 class="fs-6 fw-bold mb-1">Send WhatsApp message</h3>
    <div class="fs-7 text-muted-2 mb-3">${nf(rows.length)} selected student${rows.length === 1 ? '' : 's'} · the message goes to the father's number, else the mother's · Pay Now opens the student's own payment link</div>
    ${r.test_mode ? `<div class="alert alert-warning py-2 fs-7">Test mode: every message goes to the test number ${esc(r.test_to || '(not set)')}, at most ${nf(r.test_limit)} per send. Parents get nothing.</div>` : ''}
    <label class="form-label fs-7 fw-semibold" for="dueTplPick">Template</label>
    <select class="form-select form-select-sm mb-3" id="dueTplPick">
      <option value="">Recommended by due date (each student gets the one matching their due date)</option>
      ${r.templates.map((t) => `<option value="${esc(t.name)}"${t.name === pick ? ' selected' : ''}${tplOk(t.name) ? '' : ' disabled'}>${esc(t.name)}${tplOk(t.name) ? '' : ' (pending approval)'}</option>`).join('')}
    </select>
    <table class="table table-sm align-middle fs-7 mb-3"><thead><tr><th scope="col">Template</th><th scope="col">Status</th><th scope="col" class="text-end">Students</th></tr></thead><tbody>
      ${[...groups].map(([name, xs]) => `<tr><td>${esc(name)}</td><td>${statusChip(name)}</td><td class="text-end tnum">${nf(xs.length)}</td></tr>`).join('')}
    </tbody></table>
    ${blocked ? `<div class="alert alert-danger py-2 fs-7">${nf(blocked)} student${blocked === 1 ? '' : 's'} would need a template that is not approved yet; they will be skipped.</div>` : ''}
    <div class="fs-7 fw-semibold mb-1">Students</div>
    <div class="table-responsive mb-3" style="max-height:14rem"><table class="table table-sm align-middle fs-7 mb-0"><tbody>
      ${rows.map((x) => `<tr><td><span class="fw-semibold">${esc(x.s.name)}</span><div class="fs-8 text-muted-2">${esc(x.s.code)}</div></td>`
        + `<td class="text-end tnum">${rupees(x.amount)}</td><td class="text-nowrap">${x.first ? dueDay(x.first) : '—'}<div class="fs-8 text-muted-2">${esc(whenText(x.first))}</div></td>`
        + `<td>${esc(use(x))}${!pick ? '<div class="fs-8 text-muted-2">recommended</div>' : ''}</td><td>${tplOk(use(x)) ? '' : statusChip(use(x))}</td></tr>`).join('')}
    </tbody></table></div>
    ${rows[0] ? `<div class="fs-7 fw-semibold mb-1">Preview · ${esc(rows[0].s.name)}</div>
      <div class="phone" style="min-height:0">${waBubble(tplInfo(use(rows[0])), { amount_due: Math.round(rows[0].amount).toLocaleString('en-US'), student_name: rows[0].s.name, due_date: rows[0].first ? dueDay(rows[0].first) : '' })}</div>` : ''}`;
  $('#dueGo').disabled = rows.length === blocked;
  $('#dueGo').textContent = `Send now (${nf(rows.length - blocked)})`;
  $('#dueTplPick').addEventListener('change', paintSend);
}

/** Switch the pop-up between the student list and the send step. */
function sendMode(on) {
  $('#dueList').hidden = on; $('#dueFilters').hidden = on || !DL.r; $('#dueSend').hidden = !on;
  $('#dueBack').hidden = !on; $('#dueGo').hidden = !on; $('#dueWa').hidden = on;
  if (!on) $('#dueSend').innerHTML = '';
}

async function openSend(btn) {
  if (!DL.r || !DL.sel.size) return;
  const ok = await busy(btn, () => loadTemplates());
  if (!ok) return;
  sendMode(true);
  paintSend();
}

async function sendDueWa(btn) {
  const r = DL.r;
  if (!r) return;
  const template = $('#dueTplPick').value, month = $('#dueMonth').value || audience().months.join(',');
  const rows = sendRows().filter((x) => tplOk(template || x.rec));
  if (!rows.length) return;
  const out = await busy(btn, () => api.whatsappSend({ institute_id: DL.id, student_ids: rows.map((x) => x.s.id), month, template, filters: audience().filters }));
  if (!out) return;
  const parts = [`${nf(out.sent)} sent` + (out.test_mode ? ` to the test number ${out.to}` : '')];
  if (out.failed.length) parts.push(`${nf(out.failed.length)} failed: ${out.failed[0].error}`);
  if (out.skipped.length) parts.push(`${nf(out.skipped.length)} skipped (${[...new Set(out.skipped.map((x) => x.reason))].join(', ')})`);
  if (out.not_sent_test_limit) parts.push(`${nf(out.not_sent_test_limit)} held back (test mode)`);
  toast('WhatsApp: ' + parts.join(' · '));
  if (out.sent) sendMode(false);
}

function pickDue(e) {
  const t = e.target;
  if (t.id === 'dueAll') {
    DL.shown.forEach((s) => (t.checked ? DL.sel.add(s.i) : DL.sel.delete(s.i)));
    $$('#dueTable [data-due-pick]').forEach((el) => { el.checked = t.checked; });
  } else if (t.dataset.duePick != null) {
    const i = +t.dataset.duePick;
    t.checked ? DL.sel.add(i) : DL.sel.delete(i);
  } else return;
  paintDueSel();
}

const consented = () => D.inst.institutes.filter((x) => !locked(x));
export function chosen() { return consented().filter((x) => S.camp.scope === 'all' || S.camp.sel.has(x.id)); }

export function renderCampaigns(first) {
  const c = S.camp;
  $('#csSel').checked = c.scope === 'selected'; $('#csAll').checked = c.scope === 'all';
  $('#pv' + { sms: 'Sms', wa: 'Wa', app: 'App' }[c.pv]).checked = true;
  $('#scopeHelp').textContent = c.scope === 'all'
    ? 'Every institute that has granted consent for at least one channel. New consents join automatically.'
    : 'Pick institutes here, or arrive from a saved view, bulk selection or an Institute 360 page.';

  const mark = { y: ['Granted', 'text-green fw-semibold'], p: ['Pending', 'fw-semibold'], n: ['—', 'text-faint'] };
  const ids = new Set([...consented().map((x) => x.id), ...c.sel]);
  const list = D.inst.institutes.filter((x) => ids.has(x.id)).sort((a, b) => locked(a) - locked(b) || a.name.localeCompare(b.name));
  const hidden = D.inst.institutes.length - list.length;
  $('#audRows').innerHTML = list.map((x) => {
    const lk = locked(x), sel = !lk && (c.scope === 'all' || c.sel.has(x.id));
    const cell = (k) => `<span class="fs-7 ${mark[x.consent[k]][1]}" ${x.consent[k] === 'p' ? 'style="color:var(--mcb-amber-ink)"' : ''}>${mark[x.consent[k]][0]}</span>`;
    return `<div class="aud-row ${lk ? 'locked' : ''}" ${sel ? 'style="background:var(--mcb-violet-soft)"' : ''}>
      <input class="form-check-input m-0" type="checkbox" data-aud="${esc(x.id)}" ${sel ? 'checked' : ''} ${lk || c.scope === 'all' ? 'disabled' : ''} aria-label="Include ${esc(x.name)}">
      <span class="d-flex flex-column" style="min-width:0"><span class="fw-semibold text-truncate">${esc(x.name)}</span>${lk ? `<span class="fs-8 text-orange">No reminder consent yet · <a href="#" class="text-orange fw-semibold" data-bs-toggle="modal" data-bs-target="#consentModal">Record consent</a></span>` : `<span class="fs-8 text-muted-2 font-mono">${esc(x.db)}</span>`}</span>
      ${cell('sms')}${cell('wa')}${cell('app')}<span class="text-end tnum" data-total="${esc(x.id)}"></span><span class="text-end tnum fw-semibold" data-due="${esc(x.id)}"></span></div>`;
  }).join('') + `<div class="aud-row locked"><span></span><span class="fs-8">${list.length ? '' : 'No institute has granted reminder consent yet. '}${nf(hidden)} institutes without consent are not listed — record consent in the <a href="#" data-bs-toggle="modal" data-bs-target="#consentModal">Consent register</a>.</span></div>`;

  fillAudMonths();
  const ch = chosen();
  loadDue(ch.map((x) => x.id));
  c.ch.sms = false;   // SMS is not active for any school: no toggle, never sent
  $('#chCards').innerHTML = CH.map((k) => {
    if (k[0] === 'sms') {
      return `<div class="col-md-4"><div class="ch-card" style="opacity:.6"><div class="d-flex justify-content-between align-items-center">
        <span class="fw-bold fs-6">${k[1]}</span>${chip('Inactive', 'gray')}</div>
        <div class="fs-8 text-muted-2 mt-2">${k[2]}</div><div class="fs-8 fw-semibold mt-1">Not active for any school</div></div></div>`;
    }
    const on = !!c.ch[k[0]];
    const n = ch.filter((x) => x.consent[k[0]] === 'y').length;
    return `<div class="col-md-4"><div class="ch-card ${on ? 'on' : ''}"><div class="form-check form-switch d-flex justify-content-between align-items-center ps-0 m-0">
      <label class="form-check-label fw-bold fs-6" for="ch-${k[0]}">${k[1]}</label><input class="form-check-input ms-0" type="checkbox" role="switch" id="ch-${k[0]}" data-ch="${k[0]}" ${on ? 'checked' : ''}></div>
      <div class="fs-8 text-muted-2 mt-2">${k[2]}</div><div class="fs-8 fw-semibold mt-1">Consent at ${n} of ${ch.length} selected institutes</div></div></div>`;
  }).join('');

  if (first || !$('#cadence').children.length) {
    $('#cadence').innerHTML = CAD.map((d) => `<input type="checkbox" class="btn-check" id="cad-${d[0]}" data-cad="${d[0]}" ${c.cad[d[0]] ? 'checked' : ''}><label class="btn" for="cad-${d[0]}">${d[1]}<small>${d[2]}</small></label>`).join('');
  }
  renderPreview();

  const chOn = Object.keys(c.ch).filter((k) => c.ch[k]);
  const reach = sum(ch.filter((x) => chOn.some((k) => x.consent[k] === 'y')).map((x) => x.students));
  const days = Object.values(c.cad).filter(Boolean).length;
  const msgs = c.ch.app ? sum(ch.filter((x) => x.consent.app === 'y').map((x) => x.students)) * days : 0;   // scheduled = app only
  $('#cInst').textContent = nf(ch.length);
  $('#cReach').textContent = nf(reach);
  $('#cMsgs').textContent = nf(msgs);
  $('#cChans').textContent = chOn.length ? chOn.map((k) => CH.find((x) => x[0] === k)[1]).join(', ') : 'None';
  const waPending = ch.filter((x) => x.consent.wa === 'p').length;
  const ok = (t) => `<li class="d-flex gap-2 align-items-start"><span class="check-ic chip-green"><svg class="bi" aria-hidden="true" focusable="false"><use href="#bi-check-lg"></use></svg></span><span>${t}</span></li>`;
  const warn = (t) => `<li class="d-flex gap-2 align-items-start"><span class="check-ic chip-amber"><svg class="bi" aria-hidden="true" focusable="false"><use href="#bi-exclamation-lg"></use></svg></span><span>${t}</span></li>`;
  $('#cChecks').innerHTML = [
    ch.length ? ok("Sent only to institutes that granted reminder consent, under each institute's own name") : warn('No institute with reminder consent is selected'),
    waPending ? warn(`${waPending} selected institute${waPending > 1 ? 's have' : ' has'} WhatsApp consent pending — ${waPending > 1 ? 'they' : 'it'} will receive SMS / app only`) : ok('No pending WhatsApp consents in this audience'),
    ok('Opt-out line included; quiet hours and daily cap applied'),
    ok('Reminders stop automatically once the fee is paid')
  ].join('');
  // The schedule sends app notifications only (WhatsApp is sent by hand from the fee-due pop-up).
  const appOn = !!c.ch.app;
  $$('#cadence input').forEach((i) => { i.disabled = !appOn; });
  $('#cadence').style.opacity = appOn ? '' : '.5';
  $('#schedRules').style.opacity = appOn ? '' : '.5';
  const note = $('#schedNote');
  note.style.background = appOn ? 'var(--mcb-green-soft)' : 'var(--mcb-amber-soft)';
  note.style.color = appOn ? 'var(--mcb-green-ink)' : 'var(--mcb-amber-ink)';
  note.innerHTML = !appOn ? '<b>App push is off.</b> Turn on App push in step 2 to schedule notifications to parents.'
    : c.scheduled ? `<b>You have scheduled notifications to parents through the MCB parent app</b> on ${days ? nf(days) + ' day' + (days === 1 ? '' : 's') + ' around each due date' : 'no day yet — tick at least one'}.`
      : `<b>App push is on:</b> parents get an app notification on each ticked day${days ? '' : ' (tick at least one day)'}. WhatsApp is not scheduled; send it from the Fee due list.`;
  $('#scheduleBtn').disabled = ch.length === 0 || !appOn || days === 0;
  $('#scheduleBtn').title = appOn ? '' : 'Turn on App push to schedule notifications';
}

const PV = { r: null, err: '' };   // approved templates for the WhatsApp preview
function loadPvTemplates() {
  loadWaTemplates().then((r) => {
    const ok = r.templates.filter((t) => t.status === 'APPROVED');
    PV.r = { ...r, templates: ok };
    PV.err = ok.length ? '' : 'No approved WhatsApp template yet';
    const pick = ok.find((t) => t.name === 'fri_fee_reminder_7d_before') || ok[0];
    $('#pvTpl').innerHTML = ok.map((t) => `<option value="${esc(t.name)}"${t === pick ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    renderPreview();
  }).catch((e) => { PV.err = e.message || 'Could not load the templates'; renderPreview(); });
}

// The message box is gone from the screen: WhatsApp uses the approved templates; this text is kept for the SMS / App
// previews and the saved campaign.
const MSG = 'Dear {parent_name}, the fee of ₹{amount_due} for {student_name} at {institute} is due on {due_date}. Pay online in a minute: {pay_link}';

/* ---------- "Send test to me": pick an approved template, see it, send it to one mobile number ---------- */
// The server's fixed test values (test student, amount, due date, pay link); these are only shown until it answers.
let TEST_SAMPLE = { amount_due: '4,400', student_name: 'Kavali Vidharth Sai E', student_code: '26ARN0002', pay_link: 'https://fee.s.gy/6ilSntvGd',
  due_date: new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) };
let TEST_TPLS = [];
async function openTest(btn) {
  const r = await busy(btn, () => loadWaTemplates());
  if (!r) return;
  TEST_TPLS = r.templates.filter((t) => t.status === 'APPROVED');
  if (r.test_sample) TEST_SAMPLE = r.test_sample;
  $('#testSampleNote').textContent = `Test values: ₹${TEST_SAMPLE.amount_due} for ${TEST_SAMPLE.student_name} (${TEST_SAMPLE.student_code}), due ${TEST_SAMPLE.due_date}`;
  $('#testToHelp').textContent = `Enter the 10-digit mobile number. Only this number gets the message; Pay Now opens ${TEST_SAMPLE.pay_link}.`;
  const keep = $('#testTpl').value;
  $('#testTpl').innerHTML = TEST_TPLS.length ? TEST_TPLS.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')
    : '<option value="">No approved template yet</option>';
  $('#testTpl').value = TEST_TPLS.some((t) => t.name === keep) ? keep
    : (TEST_TPLS.find((t) => t.name === ($('#pvTpl').value || 'fri_fee_reminder_7d_before')) || TEST_TPLS[0] || {}).name || '';
  paintTest();
  showModal($('#testModal'));
}
function paintTest() {
  const t = TEST_TPLS.find((x) => x.name === $('#testTpl').value);
  $('#testPreview').innerHTML = t ? waBubble(t, TEST_SAMPLE) : '<div class="bubble p-3 text-muted-2">No approved template to preview.</div>';
  const n = $('#testTo').value, ok = /^[6-9]\d{9}$/.test(n);
  $('#testGo').disabled = !t || !ok;
  $('#testToHelp').textContent = !n ? 'Enter the 10-digit mobile number. Only this number gets the message; the Pay Now button opens a test link.'
    : ok ? `Ready to send to +91 ${n.slice(0, 5)} ${n.slice(5)}`
      : n.length < 10 ? `${n.length} of 10 digits` : 'A mobile number starts with 6, 7, 8 or 9';
}

export function renderPreview() {
  const c = S.camp;
  const msg = MSG;
  const first = chosen()[0] || (S.camp.sel.size ? rawInst([...S.camp.sel][0]) : null);
  const inst = first ? first.name : '{institute}';
  const html = esc(msg).replace(/\{institute\}/g, esc(inst)).replace(/\{pay_link\}/g, `<span class="text-blue text-decoration-underline">pay.example.in/k7Qp2</span>`).replace(/\{(\w+)\}/g, '<span class="tok">{$1}</span>');
  let out = '';
  if (c.pv === 'sms') out = `<span class="text-center fs-8 text-muted-2">[INSTITUTE SENDER ID] · SMS</span><div class="bubble p-3">${html} — Reply STOP to opt out</div>`;
  $('#pvTplRow').hidden = c.pv !== 'wa';
  if (c.pv === 'wa') {
    // WhatsApp sends only approved templates: preview the chosen one exactly as AiSensy holds it.
    const t = PV.r && (PV.r.templates.find((x) => x.name === $('#pvTpl').value) || PV.r.templates[0]);
    out = `<span class="text-center fs-8 text-muted-2">${esc(inst)} · verified business</span>`
      + (t ? waBubble(t) : `<div class="bubble p-3 text-muted-2">${PV.err ? esc(PV.err) : 'Loading the approved templates…'}</div>`);
    if (!PV.r && !PV.err) loadPvTemplates();
  }
  if (c.pv === 'app') out = `<span class="text-center fs-8 text-muted-2">MCB parent app · notification</span><div class="bubble p-3 d-flex gap-2" style="border-radius:16px"><span style="width:36px;height:36px;border-radius:9px;background:var(--mcb-night);flex:none"></span><span class="d-flex flex-column fs-7"><b>Fee due <span class="tok">{due_date}</span></b><span>₹<span class="tok">{amount_due}</span> for <span class="tok">{student_name}</span>. Tap to pay securely — UPI, card or EMI.</span></span></div>`;
  if (c.pv === 'sms') out += '<div class="text-center fs-8 text-orange mt-2">SMS is not active for any school.</div>';
  else if (!c.ch[c.pv]) out += '<div class="text-center fs-8 text-orange mt-2">This channel is switched off for the campaign.</div>';
  $('#phone').innerHTML = out;
}

// Pay-link settings are no longer on the screen; every campaign uses the defaults the form used to start with.
const PAY_LINK = { amount_mode: 'full', expiry: 'due_plus_3', short_domain: '', payment_options: ['upi', 'cards', 'netbanking', 'emi_loan'] };

function payload(status) {
  const c = S.camp;
  return {
    name: $('#cName').value.trim() || 'Untitled campaign', status, scope: c.scope,
    institute_ids: c.scope === 'selected' ? chosen().map((x) => x.id) : [],
    channels: status === 'scheduled' ? ['app'] : Object.keys(c.ch).filter((k) => c.ch[k]),   // the schedule is app-only
    parent_filters: $$('#parentFilters input:checked').map((i) => i.value),
    message: MSG, ...PAY_LINK,
    cadence: Object.keys(c.cad).filter((k) => c.cad[k])
  };
}

export function bindCampaignEvents() {
  $$('input[name="cScope"]').forEach((r) => r.addEventListener('change', () => { S.camp.scope = r.value; renderCampaigns(); }));
  $$('input[name="pv"]').forEach((r) => r.addEventListener('change', () => { S.camp.pv = r.value; renderPreview(); }));
  $('#pvTpl').addEventListener('change', renderPreview);
  const audChanged = () => loadDue(chosen().map((x) => x.id));
  $('#pfMonths').addEventListener('change', () => { $('#pfMonthClear').hidden = !audience().months.length; audChanged(); });
  $('#pfMonthClear').addEventListener('click', () => { $$('#pfMonths input').forEach((i) => { i.checked = false; }); $('#pfMonthClear').hidden = true; audChanged(); });
  $('#parentFilters').addEventListener('change', audChanged);
  $('#dueBranch').addEventListener('change', paintDueList);
  $('#dueMonth').addEventListener('change', paintDueList);
  $('#dueTable').addEventListener('change', pickDue);
  $('#dueWa').addEventListener('click', (e) => openSend(e.currentTarget));
  $('#dueGo').addEventListener('click', (e) => sendDueWa(e.currentTarget));
  $('#dueBack').addEventListener('click', () => { sendMode(false); paintDueSel(); });
  $('#audRows').addEventListener('click', (e) => { const a = e.target.closest('[data-due-list]'); if (!a) return; e.preventDefault(); showDueList(a.dataset.dueList); });
  $('#audRows').addEventListener('change', (e) => { const id = e.target.dataset.aud; if (!id) return; if (e.target.checked) S.camp.sel.add(id); else S.camp.sel.delete(id); renderCampaigns(); });
  $('#chCards').addEventListener('change', (e) => { const k = e.target.dataset.ch; if (!k || k === 'sms') return; S.camp.ch[k] = e.target.checked; if (k === 'app') S.camp.scheduled = false; renderCampaigns(); });
  $('#cadence').addEventListener('change', (e) => { const k = e.target.dataset.cad; if (!k) return; S.camp.cad[k] = e.target.checked; S.camp.scheduled = false; renderCampaigns(); });
  $('#saveDraftBtn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const r = await api.saveCampaign(payload('draft'));
    $('#campStatus').textContent = 'Draft saved';
    toast(`Draft saved · ${r.institutes} institute${r.institutes === 1 ? '' : 's'}`);
  }));
  $('#testSendBtn').addEventListener('click', (e) => openTest(e.currentTarget));
  $('#testTpl').addEventListener('change', paintTest);
  $('#testTo').addEventListener('input', () => { $('#testTo').value = $('#testTo').value.replace(/\D/g, '').slice(0, 10); paintTest(); });
  $('#testGo').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const r = await api.whatsappTest({ to: $('#testTo').value, template: $('#testTpl').value });
    toast(`Test WhatsApp (${r.template}) accepted for the number ending ${r.to}`);
  }));
  $('#scheduleBtn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const r = await api.saveCampaign(payload('scheduled'));
    $('#campStatus').textContent = 'Scheduled';
    S.camp.scheduled = true; renderCampaigns();
    toast(`Scheduled: parents at ${r.institutes} institute${r.institutes === 1 ? '' : 's'} will get app notifications around each due date`);
  }));
}
