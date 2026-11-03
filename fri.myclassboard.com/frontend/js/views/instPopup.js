/* Institute pop-up (#instModal): one school's details, a list of schools, or a top / bottom 10% ranking.
   Views register the lists their tiles and bars open (registerList); app.js routes the clicks here.
   Every rupee figure in the pop-up is for the whole financial year (the months in D.modes.months), taken from the
   school's fy_modes, so "Fees collected" always equals the sum of the payment methods listed under it. */
import { api } from '../api.js';
import { D, INST, instById, rates, gfParams } from '../store.js';
import { esc, nf, rs, pct, sum, range, fullMonth, fmtDate, fmtDay } from '../format.js';
import { STATUS, playChip } from '../metrics.js';
import { SEG, SEG_HELP, segName, BRANCH_STATUS, OFFLINE_GROUPS, gwLabel, groupModes, groupName, modeColorKey, mixBar, branchCell, branchesTotal, gatewayUsage } from '../segments.js';
import { pal } from '../chart.js';
import { $, chip, showModal, toast, toastError } from '../ui.js';

const PAGE = 15;
const LISTS = new Map();            // key -> { title (HTML), list: [institute], note }
const cur = { key: '', q: '', shown: PAGE };
let seq = 0;                        // guards the async notes load against a newer pop-up

/** Make a list of schools openable by key (`data-list-popup="key"`). Called on every render, so it follows the filters.
 *  `extra(x)` may return one more line of HTML for a school's card (e.g. what it paid through a loan partner). */
export function registerList(key, title, list, note = '', extra = null) { LISTS.set(key, { title, list, note, extra }); }
export const curListKey = () => cur.key;

const fyLbl = () => range(D.modes.months);
/** 'whole financial year, Apr–Sep', or 'selected months, Jun–Aug' when a month range is picked in the filter bar. */
const periodLbl = () => { const f = gfParams(); return ((f.from || f.to) ? 'selected months, ' : 'whole financial year, ') + fyLbl(); };
const fyTotal = (x) => sum(Object.values(x.fy_modes || {}));
/** A school's whole-FY money: total, online through the MCB gateway, offline (cash, card, cheque, DD) and the rest. */
function fyParts(x) {
  const g = groupModes(x.fy_modes);
  const total = fyTotal(x);
  const offline = sum(OFFLINE_GROUPS.map((k) => g[k] || 0));
  return { g, total, pg: g.pg || 0, offline, other: Math.max(0, total - (g.pg || 0) - offline) };
}
/** Payment-mode name as the database has it (dbo.MCBFeePaymentModes), for a mode key. */
function modeName(key) {
  const hit = (D.modes.modes || []).find((m) => m.key === key) || (D.opts.modes || []).find((o) => o.value === key);
  return hit ? (hit.name || hit.label) : `Unmapped mode (${key.replace(/^m/, '')})`;
}

function frame(titleHtml, sub, { back = false, open = '' } = {}) {
  seq++;
  $('#instPopTitle').innerHTML = titleHtml;
  $('#instPopSub').textContent = sub;
  $('#instPopBack').hidden = !back;
  const o = $('#instPopOpen');
  o.hidden = !open;
  if (open) o.setAttribute('href', '#institute/' + encodeURIComponent(open));
  showModal($('#instModal'));
}

const segChip = (x) => {
  const s = SEG[x.partner_status];
  return s ? `<span class="chip chip-${s.tone}" title="${esc(SEG_HELP[x.partner_status])}">${segName(x.partner_status, true)}</span>` : '';
};
const statusChip = (x) => (STATUS[x.status] ? chip(STATUS[x.status][0], STATUS[x.status][1]) : '');
const stat = (label, value, sub = '', cls = '') => `<div class="stat-box"><div class="fs-8 text-muted-2">${esc(label)}</div><div class="fw-bold fs-5 ${cls}">${value}</div>${sub ? `<div class="fs-8 text-faint">${esc(sub)}</div>` : ''}</div>`;
const share = (v, tot) => (tot ? pct(100 * v / tot) : '—');

/* ---------------- School details ---------------- */
/* Activity: everything done against the institute in the portal (notes / calls, pipeline, owner, consent, campaigns). */
const ACT_KIND = { activity: ['Update', 'violet'], note: ['Note / call', 'blue'], pipeline: ['Pipeline', 'violet'], owner: ['Owner', 'gray'], consent: ['Consent', 'green'], campaign: ['Campaign', 'amber'] };
const ACT_SHOWN = 8;
function activityRows(list, all) {
  if (!list.length) return '<span class="text-faint">Nothing recorded yet. Notes, calls, pipeline changes, owner and consent changes and campaigns will show here.</span>';
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = (all ? list : list.slice(0, ACT_SHOWN)).map((a) => {
    const k = ACT_KIND[a.kind] || [a.kind, 'gray'];
    return `<div class="d-flex gap-2 align-items-start border-bottom" style="padding:6px 0">
      <span class="text-muted-2 text-nowrap fs-8" style="min-width:132px">${esc(when(a.at))}</span>
      <span style="min-width:0">${chip(k[0], k[1])} ${esc(a.text)}<div class="fs-8 text-muted-2">${a.who ? 'by ' + esc(a.who) : 'before activity was recorded · who did it is not known'}</div></span></div>`;
  }).join('');
  return rows + (!all && list.length > ACT_SHOWN
    ? `<button type="button" class="btn btn-link btn-sm p-0 mt-1" data-act-all>Show all ${nf(list.length)} activities</button>` : '');
}

/** The Activity block: who owns the institute, the add box (assigned owner only) and the entries. */
function paintActivity(id, v, all) {
  const box = $('#instPopActivity');
  const owners = v.owners.length ? v.owners.map(esc).join(', ') : 'no owner assigned';
  const add = v.can_add
    ? `<div class="d-flex gap-2 align-items-start mb-2"><textarea id="actText" class="form-control form-control-sm" rows="2" maxlength="1000" placeholder="What happened? e.g. Met the principal, demo fixed for Monday"></textarea>
        <button type="button" class="btn btn-primary btn-sm text-nowrap" data-act-add>Add activity</button></div>`
    : `<div class="fs-8 text-muted-2 mb-2">Only the assigned owner (${owners}) can add activity.</div>`;
  box.innerHTML = `<div class="fs-8 text-muted-2 mb-2">Owner: <b class="text-body">${owners}</b></div>${add}${activityRows(v.items, all)}`;
  box.onclick = async (e) => {
    if (e.target.closest('[data-act-all]')) { paintActivity(id, v, true); return; }
    const b = e.target.closest('[data-act-add]');
    if (!b) return;
    const t = $('#actText').value.trim();
    if (!t) { $('#actText').focus(); return; }
    b.disabled = true;
    try { paintActivity(id, await api.addActivity(id, t), all); toast('Activity added'); }
    catch (err) { b.disabled = false; toastError(err); }
  };
}

export function openInstPopup(id, fromList = '') {
  const x = instById(id);
  if (!x) return false;
  frame(esc(x.name), `${x.db} · organisation ${x.org_id}`, { back: !!fromList, open: x.id });
  const mine = seq;
  const f = fyParts(x), nBr = branchesTotal(x.branch_mix), P = pal();
  const inPipe = ((D.pipe && D.pipe.deals) || []).some((d) => d.institute_id === x.id);   // Activity only once in the pipeline
  // Every payment method the school used, by its database name, biggest first; the rows add up to "Fees collected".
  const modeRows = Object.entries(x.fy_modes || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td><span class="d-flex align-items-center gap-2"><i class="sw" style="background:${P[modeColorKey(k)]}"></i>${esc(modeName(k))}</span></td><td class="text-end tnum">${rs(v)}</td><td class="text-end tnum">${share(v, f.total)}</td></tr>`).join('');
  $('#instPopBody').innerHTML = `<div class="d-flex flex-column gap-3">
    <div class="d-flex flex-wrap gap-2">${segChip(x)}${statusChip(x)}${playChip(x.play)}</div>
    <div class="border rounded-3 p-3"><div class="fs-8 text-muted-2 mb-2 fw-semibold">Account</div>${accountGrid(x)}</div>
    ${inPipe ? `<div class="border rounded-3 p-3"><div class="d-flex justify-content-between align-items-baseline"><b>Activity</b><span class="fs-8 text-muted-2">newest first</span></div>
      <div id="instPopActivity" class="fs-7 mt-1"><span class="text-faint">Loading activity…</span></div></div>` : ''}
    <div>
      <div class="fs-8 text-muted-2 mb-1">Key figures · ${esc(periodLbl())}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px">
        ${stat('Fees collected', rs(f.total), 'every payment method')}
        ${stat('Paid online via MCB gateway', rs(f.pg), share(f.pg, f.total) + ' of fees', 'text-violet')}
        ${stat('Paid offline', rs(f.offline), share(f.offline, f.total) + ' · cash, card, cheque, DD', 'text-orange')}
        ${stat('Paid other ways', rs(f.other), share(f.other, f.total) + ' · bank transfer, auto-debit, loan…')}
        ${stat('Students', nf(x.students), 'most paying in one month')}
        ${stat('Opportunity score', nf(x.score), `+${rs(x.revYr)} commission / yr if ${nf(rates().conv * 100)}% of offline moves online`)}
      </div>
      <div class="fs-8 text-faint mt-1">Online + offline + other ways = fees collected.</div>
    </div>
    <div><b>Gateways</b>${gatewayUsage(x)}</div>
    <div><b>Branches</b><div class="mt-1" style="max-width:420px">${nBr ? branchCell(x) : '<span class="fs-8 text-faint">No branch information</span>'}</div></div>
    <div><b>Every payment method</b> <span class="fs-8 text-muted-2">${esc(periodLbl())}</span>
      ${f.total ? `<div class="mt-1">${mixBar(f.g, 12, false)}</div>
      <table class="table table-sm align-middle mb-0 mt-1"><thead><tr><th scope="col">Payment method</th><th scope="col" class="text-end">Amount</th><th scope="col" class="text-end">% of fees</th></tr></thead>
        <tbody>${modeRows}</tbody>
        <tfoot><tr class="fw-bold"><td>Total fees collected</td><td class="text-end tnum">${rs(f.total)}</td><td class="text-end tnum">100.0%</td></tr></tfoot></table>`
    : '<div class="fs-8 text-faint mt-1">No fees in the selected months.</div>'}</div>
    <div><b>Notes</b><div id="instPopNotes" class="fs-7 mt-1"><span class="text-faint">Loading notes…</span></div></div>
  </div>`;
  if (inPipe) api.activity(x.id).then((v) => {
    if (mine !== seq) return;
    paintActivity(x.id, v, false);
  }).catch(() => {
    if (mine === seq) $('#instPopActivity').innerHTML = '<span class="text-faint">Activity is not available right now.</span>';
  });
  api.notes(x.id).then((notes) => {
    if (mine !== seq) return;
    $('#instPopNotes').innerHTML = notes.length
      ? notes.slice(0, 5).map((n) => `<div class="border-bottom" style="padding:4px 0"><span class="text-muted-2">${esc(fmtDate(n.created_at.slice(0, 10)))}</span> · ${esc(n.text)}${n.follow_up ? ` <span class="text-muted-2">· follow up ${esc(fmtDay(n.follow_up))}</span>` : ''}</div>`).join('')
        + (notes.length > 5 ? `<div class="fs-8 text-faint pt-1">${nf(notes.length - 5)} older note${notes.length - 5 === 1 ? '' : 's'} on the full page.</div>` : '')
      : '<span class="text-faint">No notes yet. Add one from the full page.</span>';
  }).catch(() => {
    if (mine === seq) $('#instPopNotes').innerHTML = '<span class="text-faint">Notes are not available right now.</span>';
  });
  return true;
}

/* The account block: who looks after the organisation (from the database; — = not recorded). */
export const ACCOUNT_FIELDS = [['Organisation', (x) => x.name], ['DB instance', (x) => x.db], ['Location', (x) => (x.account || {}).location],
  ['Account manager', (x) => (x.account || {}).account_manager], ['Implementation manager', (x) => (x.account || {}).implementation_manager],
  ['Implementation executive', (x) => (x.account || {}).implementation_executive], ['Sales person', (x) => (x.account || {}).sales_person],
  ['RM', (x) => (x.account || {}).rm], ['CSM', (x) => (x.account || {}).csm], ['Customer type', (x) => (x.account || {}).customer_type]];
export const accountGrid = (x) => `<div data-account style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 18px">${ACCOUNT_FIELDS.map(([l, f]) => {
  const v = f(x);
  return `<div style="min-width:0"><div class="fs-8 text-muted-2">${l}</div><div class="fw-semibold" style="overflow-wrap:anywhere">${v ? esc(v) : '<span class="text-faint">—</span>'}</div></div>`;
}).join('')}</div>`;
/** Every name on the account, for searching. */
export const accountText = (x) => Object.values(x.account || {}).join(' ').toLowerCase();

/* ---------------- List of schools ---------------- */
const matches = (x, q) => !q || x.name.toLowerCase().includes(q) || x.db.toLowerCase().includes(q) || accountText(x).includes(q) || (x.gateways || []).some((n) => n.toLowerCase().includes(q));

function card(x, key) {
  const f = fyParts(x), more = (LISTS.get(key) || {}).extra;
  return `<div class="border rounded-3 p-2 px-3 d-flex flex-wrap align-items-center gap-2">
    <div class="flex-grow-1" style="min-width:220px">
      <div class="fw-650">${esc(x.name)}</div>
      <div class="fs-8 text-muted-2">${esc(x.db)}${x.branches ? ` · ${nf(x.branches)} branch${x.branches === 1 ? '' : 'es'}` : ''}${x.students ? ` · ${nf(x.students)} students` : ''}${x.account_manager ? ` · Account manager: <b class="text-body">${esc(x.account_manager)}</b>` : ''}</div>
      <div class="d-flex flex-wrap gap-1 mt-1">${segChip(x)}${statusChip(x)}</div>
      ${more ? `<div class="fs-7 mt-1" data-card-extra>${more(x)}</div>` : ''}
    </div>
    <div class="text-end fs-7 tnum">
      <div>Fees collected: <b>${rs(f.total)}</b></div>
      <div>Online via MCB: <b class="text-violet">${rs(f.pg)}</b> (${share(f.pg, f.total)})</div>
      <div>Offline: <b class="text-orange">${rs(f.offline)}</b> · Other ways: <b>${rs(f.other)}</b></div>
    </div>
    <button type="button" class="btn btn-sm btn-quiet" data-inst-popup="${esc(x.id)}" data-from-list="${esc(key)}">Full details</button>
  </div>`;
}

function paintCards() {
  const L = LISTS.get(cur.key);
  const box = $('#instPopCards');
  if (!L || !box) return;
  const q = cur.q.trim().toLowerCase();
  const list = L.list.filter((x) => matches(x, q));
  const shown = list.slice(0, cur.shown);
  box.innerHTML = (shown.map((x) => card(x, cur.key)).join('') || '<div class="text-center text-muted-2 py-4">No school matches.</div>')
    + `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 fs-7 text-muted-2 pt-1">
        <span>Showing ${nf(shown.length)} of ${nf(list.length)} school${list.length === 1 ? '' : 's'}</span>
        ${shown.length < list.length ? `<button type="button" class="btn btn-sm btn-quiet" data-list-more="${esc(cur.key)}">Show ${nf(Math.min(PAGE, list.length - shown.length))} more</button>` : ''}
      </div>`;
}

function paintList() {
  const L = LISTS.get(cur.key);
  if (!L) return;
  const tot = L.list.reduce((a, x) => { const f = fyParts(x); a.total += f.total; a.pg += f.pg; a.offline += f.offline; a.other += f.other; return a; }, { total: 0, pg: 0, offline: 0, other: 0 });
  frame(L.title, `${nf(L.list.length)} school${L.list.length === 1 ? '' : 's'}${L.note ? ' · ' + L.note : ''} · ${periodLbl()}`);
  $('#instPopBody').innerHTML = `<div class="d-flex flex-column gap-2">
    <div id="instPopTotals" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
      ${stat('Fees collected, all ' + nf(L.list.length), rs(tot.total))}
      ${stat('Online via MCB gateway', rs(tot.pg), share(tot.pg, tot.total), 'text-violet')}
      ${stat('Offline', rs(tot.offline), share(tot.offline, tot.total) + ' · cash, card, cheque, DD', 'text-orange')}
      ${stat('Other ways', rs(tot.other), share(tot.other, tot.total) + ' · bank transfer, auto-debit, loan…')}
    </div>
    <label for="instPopFind" class="visually-hidden-label">Find a school in this list</label>
    <input id="instPopFind" type="search" class="form-control" placeholder="Find a school, DB or gateway in this list" autocomplete="off" data-list-key="${esc(cur.key)}" value="${esc(cur.q)}">
    <div id="instPopCards" class="d-flex flex-column gap-2"></div></div>`;
  paintCards();
}

/** Open a registered list. With `q` (typing in the search box) only the cards are redrawn, so the box keeps focus. */
export function openListPopup(key, q) {
  if (key.startsWith('rank:')) { openRankPopup(key.slice(5)); return; }
  if (!LISTS.has(key)) return;
  if (q !== undefined && cur.key === key && $('#instPopCards')) { cur.q = q; cur.shown = PAGE; paintCards(); return; }
  cur.key = key; cur.q = q || ''; cur.shown = PAGE;
  paintList();
}
/** Back from a school's details: the same list, search and length as before. */
export function reopenList(key) {
  if (key.startsWith('inst:')) { openInstPopup(key.slice(5)); return; }
  if (key === 'month:') { paintMonth(); return; }
  if (key === 'months:') { paintMonths(); return; }
  if (key.startsWith('rank:')) { openRankPopup(key.slice(5)); return; }
  if (!LISTS.has(key)) return;
  cur.key = key;
  paintList();
}
export function listMore(key, q = '') {
  if (cur.key !== key) return;
  cur.q = q; cur.shown += PAGE;
  paintCards();
}

/* ---------------- Top and bottom 10% ---------------- */
const BR_LABEL = Object.fromEntries(BRANCH_STATUS.map(([k, l]) => [k, l]));

/** kind:value -> { title (HTML), by, pool, val, fmt }. seg = one gateway group · br = one branch state · mode = one payment group. */
function ranking(key) {
  const i = key.indexOf(':'), kind = key.slice(0, i), v = key.slice(i + 1);
  const all = INST();
  if (kind === 'seg') return { title: segName(v), by: 'fees collected in ' + fyLbl(), pool: all.filter((x) => x.partner_status === v), val: fyTotal, fmt: rs };
  if (kind === 'br') {
    return { title: esc(BR_LABEL[v] || v), by: 'number of branches in this state', pool: all.filter((x) => (x.branch_mix[v] || 0) > 0),
      val: (x) => x.branch_mix[v] || 0, fmt: (n, x) => `${nf(n)} of ${nf(branchesTotal(x.branch_mix))} branches` };
  }
  if (kind === 'mode') {
    return { title: groupName(v), by: 'share of fees paid this way', pool: all.filter((x) => fyTotal(x) > 0),
      val: (x) => (groupModes(x.fy_modes)[v] || 0) / fyTotal(x), fmt: (s, x) => `${pct(s * 100)} · ${rs(s * fyTotal(x))}` };
  }
  return null;
}

export function openRankPopup(key) {
  const R = ranking(key);
  if (!R) return;
  cur.key = 'rank:' + key;
  const rows = R.pool.map((x) => ({ x, v: R.val(x) })).sort((a, b) => b.v - a.v);
  const n = rows.length ? Math.max(1, Math.ceil(rows.length / 10)) : 0;
  const top = rows.slice(0, n);
  const bottom = rows.slice(Math.max(n, rows.length - n)).reverse();     // never repeats a school already in the top list
  frame(`${R.title}: top and bottom 10%`, `${nf(rows.length)} school${rows.length === 1 ? '' : 's'}, ranked by ${R.by}`);
  const col = (label, list, cls) => `<div class="col"><div class="fw-semibold ${cls} mb-1">${label} · ${nf(list.length)} school${list.length === 1 ? '' : 's'}</div>
    ${list.length ? `<ol class="list-unstyled m-0 d-flex flex-column gap-1">${list.map((r, i) => `<li class="d-flex justify-content-between gap-2 border-bottom fs-7" style="padding:4px 0">
        <span><span class="text-faint tnum">${i + 1}.</span> <a href="#institute/${encodeURIComponent(r.x.id)}" class="text-reset fw-650" data-inst-popup="${esc(r.x.id)}" data-from-list="${esc(cur.key)}">${esc(r.x.name)}</a></span>
        <span class="tnum text-end text-nowrap">${R.fmt(r.v, r.x)}</span></li>`).join('')}</ol>`
    : '<div class="fs-8 text-faint">Not enough schools to rank.</div>'}</div>`;
  $('#instPopBody').innerHTML = rows.length
    ? `<div class="row row-cols-1 row-cols-md-2 g-3">${col('Top 10%', top, 'text-violet')}${col('Bottom 10%', bottom, 'text-orange')}</div>`
    : '<div class="text-center text-muted-2 py-4">No schools in this group for the current filters.</div>';
}

/* ---------------- One month behind a chart column ----------------
   Opened by clicking a month in a chart. Everything shown is computed by the server (/api/month-detail) from the
   database for that month and the filters on screen; nothing here is re-derived in the browser. */
const MONTH_PAGE = 25;
const MONTH = { opts: null, data: null, shown: MONTH_PAGE };
const money2 = (v) => `<span title="₹${nf(v, 2)}">${rs(v)}</span>`;

/** opts: { kind: 'all' | group key | payment-mode key, month: 'Apr', inst?: institute id, back?: list key to return to } */
export async function openMonthPopup(opts) {
  cur.key = opts.back || 'month:';
  MONTH.opts = opts; MONTH.data = null; MONTH.shown = MONTH_PAGE;
  frame(`${esc(fullMonth(opts.month))}: loading…`, 'Reading this month from the database', { back: !!opts.back });
  $('#instPopBody').innerHTML = '<div class="text-center text-muted-2 py-5">Loading…</div>';
  const mine = seq;
  try {
    const p = { ...gfParams(), month: opts.month, kind: opts.kind };
    if (opts.inst) p.inst = opts.inst;
    const data = await api.monthDetail(p);
    if (mine !== seq) return;
    MONTH.data = data;
    paintMonth();
  } catch (err) {
    if (mine === seq) $('#instPopBody').innerHTML = `<div class="alert alert-danger m-0" role="alert">This month could not be loaded: ${esc(err.message)}</div>`;
  }
}

function paintMonth() {
  const d = MONTH.data, o = MONTH.opts;
  if (!d) return;
  const school = o.inst ? instById(o.inst) : null;
  frame(`${esc(fullMonth(d.month))} ${d.year}: ${esc(d.label)}${school ? ' · ' + esc(school.name) : ''}`,
    `${o.inst ? '' : nf(d.institutes.length) + ` school${d.institutes.length === 1 ? '' : 's'} · `}${nf(d.txns)} payment${d.txns === 1 ? '' : 's'} · from the database, for the filters on screen`, { back: !!o.back });
  const modeRows = d.modes.map((m) => `<tr><td><span class="d-flex align-items-center gap-2"><i class="sw" style="background:${pal()[modeColorKey(m.key)]}"></i>${esc(m.name)}</span></td>
      <td class="text-end tnum">${money2(m.amount_rs)}</td><td class="text-end tnum">${nf(m.txns)}</td><td class="text-end tnum">${share(m.amount_rs, d.total_rs)}</td></tr>`).join('');
  const shown = d.institutes.slice(0, MONTH.shown);
  const instRows = shown.map((r, i) => `<tr><td class="text-faint tnum">${i + 1}</td>
      <td><a href="#institute/${encodeURIComponent(r.id)}" class="text-reset fw-650" data-inst-popup="${esc(r.id)}" data-from-list="month:">${esc(r.name)}</a><div class="fs-8 text-muted-2">${esc(r.db)}</div></td>
      <td class="text-end tnum">${money2(r.amount_rs)}</td><td class="text-end tnum">${nf(r.txns)}</td><td class="text-end tnum">${share(r.amount_rs, d.total_rs)}</td></tr>`).join('');
  const instSum = sum(d.institutes.map((r) => r.amount_rs));
  $('#instPopBody').innerHTML = `<div class="d-flex flex-column gap-3">
    <div id="monthStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
      ${stat(d.label, money2(d.total_rs), `${fullMonth(d.month)} ${d.year}`, 'text-violet')}
      ${stat('Payments', nf(d.txns))}
      ${o.inst ? '' : stat('Schools', nf(d.institutes.length))}
      ${stat('Average payment', d.txns ? rs(d.total_rs / d.txns) : '—')}
    </div>
    <div><b>Payment methods</b>
      <table class="table table-sm align-middle mb-0 mt-1" id="monthModes"><thead><tr><th scope="col">Payment method</th><th scope="col" class="text-end">Amount</th><th scope="col" class="text-end">Payments</th><th scope="col" class="text-end">% of this month</th></tr></thead>
        <tbody>${modeRows || '<tr><td colspan="4" class="text-muted-2">No fees of this kind in this month.</td></tr>'}</tbody>
        <tfoot><tr class="fw-bold"><td>Total</td><td class="text-end tnum">${money2(d.total_rs)}</td><td class="text-end tnum">${nf(d.txns)}</td><td class="text-end tnum">${d.total_rs ? '100.0%' : '—'}</td></tr></tfoot></table></div>
    ${o.inst ? '' : `<div><b>Schools</b> <span class="fs-8 text-muted-2">biggest first · all ${nf(d.institutes.length)} add up to ${rs(instSum)}</span>
      <table class="table table-sm align-middle mb-0 mt-1" id="monthSchools"><thead><tr><th scope="col" style="width:36px">#</th><th scope="col">School</th><th scope="col" class="text-end">Amount</th><th scope="col" class="text-end">Payments</th><th scope="col" class="text-end">% of this month</th></tr></thead>
        <tbody>${instRows || '<tr><td colspan="5" class="text-muted-2">No school paid this way in this month.</td></tr>'}</tbody></table>
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 fs-7 text-muted-2 pt-2">
        <span>Showing ${nf(shown.length)} of ${nf(d.institutes.length)} school${d.institutes.length === 1 ? '' : 's'}</span>
        ${shown.length < d.institutes.length ? `<button type="button" class="btn btn-sm btn-quiet" data-month-more>Show ${nf(Math.min(MONTH_PAGE, d.institutes.length - shown.length))} more</button>` : ''}
      </div></div>`}
  </div>`;
}
export function monthMore() { MONTH.shown += MONTH_PAGE; paintMonth(); }

/* ---------------- Every month of one school (or of the filters on screen) ----------------
   Opened from the headline boxes on a school's page. The server (/api/monthly-summary) sums each month and each
   part of it from the database; the rows add up to the total row, and the parts add up to each month's fees. */
const MONTHS_POP = { opts: null, data: null };

/** opts: { inst?: institute id, kind?: 'all' | SUMMARY group key: the box that was clicked; its column is highlighted
 *  and a month row opens that kind of fees for the month } */
export async function openMonthsPopup(opts) {
  cur.key = 'months:';
  MONTHS_POP.opts = opts; MONTHS_POP.data = null;
  const school = opts.inst ? instById(opts.inst) : null;
  frame(`${esc(school ? school.name : 'All schools')}: fees collected, month by month`, 'Reading every month from the database');
  $('#instPopBody').innerHTML = '<div class="text-center text-muted-2 py-5">Loading…</div>';
  const mine = seq;
  try {
    const p = { ...gfParams() };
    if (opts.inst) p.inst = opts.inst;
    const data = await api.monthlySummary(p);
    if (mine !== seq) return;
    MONTHS_POP.data = data;
    paintMonths();
  } catch (err) {
    if (mine === seq) $('#instPopBody').innerHTML = `<div class="alert alert-danger m-0" role="alert">The months could not be loaded: ${esc(err.message)}</div>`;
  }
}

function paintMonths() {
  const d = MONTHS_POP.data, o = MONTHS_POP.opts;
  if (!d) return;
  const school = o.inst ? instById(o.inst) : null;
  const first = d.months[0], last = d.months[d.months.length - 1];
  // (the title is set again below, once `focus` is known)
  frame(`${esc(school ? school.name : 'All schools')}: fees collected, month by month`,
    `${first ? `${fullMonth(first.month)} ${first.year} to ${fullMonth(last.month)} ${last.year}` : 'No complete months'} · ${nf(d.txns)} payments · from the database · click a month for its ${o.inst ? 'payment methods' : 'schools and payment methods'}`,
    { open: o.inst || '' });
  const cols = d.groups.filter((g) => d.group_totals[g.key]);          // only the parts this school actually has
  const kind = o.kind && o.kind !== 'all' && d.groups.some((g) => g.key === o.kind) ? o.kind : 'all';
  const focus = d.groups.find((g) => g.key === kind);
  const hi = (k) => (k === kind ? ' style="background:var(--mcb-violet-soft)"' : '');
  $('#instPopTitle').innerHTML = `${esc(school ? school.name : 'All schools')}: ${focus ? esc(focus.label) : 'fees collected'}, month by month`;
  const cell = (v, cls = '', k = '') => `<td class="text-end tnum ${cls}"${hi(k)}>${v ? money2(v) : '<span class="text-faint">—</span>'}</td>`;
  const tone = { pg: 'text-violet', offline: 'text-orange' };
  const rows = d.months.map((m) => `<tr data-month-open="${esc(m.month)}" data-inst="${esc(o.inst || '')}" data-kind="${esc(kind)}" role="button" tabindex="0" style="cursor:pointer" title="Click for ${esc(fullMonth(m.month))}'s ${o.inst ? 'payment methods' : 'schools and payment methods'}">
      <td class="fw-semibold">${esc(fullMonth(m.month))} ${m.year}</td>${cell(m.total_rs, 'fw-semibold', 'all')}
      ${cols.map((g) => cell(m.groups[g.key] || 0, tone[g.key] || '', g.key)).join('')}
      <td class="text-end tnum">${nf(m.txns)}</td><td class="text-end tnum">${share(m.total_rs, d.total_rs)}</td></tr>`).join('');
  $('#instPopBody').innerHTML = `<div class="d-flex flex-column gap-3">
    <div id="monthsStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
      ${stat('Fees collected, all months', money2(d.total_rs), `${d.months.length} month${d.months.length === 1 ? '' : 's'}`, 'text-violet')}
      ${stat('Payments', nf(d.txns))}
      ${stat('Average per month', d.months.length ? money2(d.total_rs / d.months.length) : '—')}
      ${(() => { const b = d.months.slice().sort((x, y) => y.total_rs - x.total_rs)[0]; return b ? stat('Biggest month', money2(b.total_rs), `${fullMonth(b.month)} ${b.year}`) : ''; })()}
    </div>
    <div class="table-responsive">
      <table class="table table-sm table-hover align-middle mb-0" id="monthsTable" style="min-width:${420 + 110 * cols.length}px">
        <thead><tr><th scope="col">Month</th><th scope="col" class="text-end"${hi('all')}>Fees collected</th>
          ${cols.map((g) => `<th scope="col" class="text-end"${hi(g.key)}>${esc(g.short)}</th>`).join('')}
          <th scope="col" class="text-end">Payments</th><th scope="col" class="text-end">% of all months</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="text-muted-2">No fees in these months.</td></tr>'}</tbody>
        <tfoot><tr class="fw-bold"><td>Total</td>${cell(d.total_rs, '', 'all')}${cols.map((g) => cell(d.group_totals[g.key] || 0, tone[g.key] || '', g.key)).join('')}
          <td class="text-end tnum">${nf(d.txns)}</td><td class="text-end tnum">${d.total_rs ? '100.0%' : '—'}</td></tr></tfoot>
      </table>
    </div>
    <div class="fs-8 text-faint">In every row the payment-method columns add up to "Fees collected", and the months add up to the total row. Every amount is exact, to the paisa.</div>
  </div>`;
}

/* ---------------- Which branch uses which gateway ----------------
   Opened from "See which branch uses which gateway" under a school's name. One block per gateway, with its
   branches listed inside; the data is the school's branch → gateway mapping as the server sent it. */
export function openBranchPopup(id, fromDetails = false) {
  const x = instById(id);
  if (!x) return false;
  const groups = (x.branch_gateways || []).filter((g) => g.kind !== 'inactive');
  // A branch can be on more than one gateway: note the others next to it.
  const where = new Map();
  groups.forEach((g) => g.branches.forEach((b) => { if (!where.has(b)) where.set(b, []); where.get(b).push(gwLabel(g).name); }));
  const total = where.size;
  const onMcb = [...where.keys()].filter((b) => groups.some((g) => (g.kind === 'partner' || g.kind === 'non_partner' || g.kind === 'unknown') && g.branches.includes(b))).length;
  cur.key = fromDetails ? 'inst:' + x.id : '';
  frame(`${esc(x.name)}: which branch uses which gateway`,
    `${nf(total)} branch${total === 1 ? '' : 'es'} · ${nf(groups.length)} group${groups.length === 1 ? '' : 's'} · ${x.db}`, { back: fromDetails, open: x.id });
  const blocks = groups.map((g) => {
    const m = gwLabel(g);
    const list = g.branches.slice().sort((a, b) => a.localeCompare(b));
    return `<section class="border rounded-3 overflow-hidden" data-branch-group>
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 px-3 py-2" style="background:var(--mcb-surface-2)">
        <span class="d-flex align-items-center gap-2"><i class="sw" style="background:${m.color}"></i><b>${esc(m.name)}</b>${m.tag ? `<span class="chip chip-${m.tone}">${esc(m.tag)}</span>` : ''}</span>
        <span class="fs-7"><b data-branch-count>${nf(list.length)}</b> of ${nf(total)} branches · ${share(list.length, total)}</span>
      </div>
      <ol class="list-unstyled m-0 px-3 py-2 fs-7" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 16px">
        ${list.map((b) => { const also = where.get(b).filter((n) => n !== m.name);
          return `<li data-branch="${esc(b.toLowerCase())}">${esc(b)}${also.length ? ` <span class="fs-8 text-muted-2">· also ${esc(also.join(', '))}</span>` : ''}</li>`; }).join('')}
      </ol></section>`;
  }).join('');
  $('#instPopBody').innerHTML = groups.length ? `<div class="d-flex flex-column gap-3">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">
      ${stat('Branches', nf(total))}
      ${stat('Use an MCB gateway', nf(onMcb), share(onMcb, total), 'text-violet')}
      ${stat('No MCB gateway', nf(total - onMcb), share(total - onMcb, total), total - onMcb ? 'text-orange' : '')}
    </div>
    ${total > 12 ? `<div><label for="branchFind" class="visually-hidden-label">Find a branch</label>
      <input id="branchFind" type="search" class="form-control" placeholder="Find a branch by name" autocomplete="off"></div>` : ''}
    <div class="d-flex flex-column gap-3" id="branchGroups">${blocks}</div>
    <div class="text-center text-muted-2 py-3" id="branchNone" hidden>No branch matches.</div>
  </div>` : '<div class="text-center text-muted-2 py-4">No branch information for this school.</div>';
  return true;
}
// Typing in the branch search hides the branches that do not match and updates each block's count.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'branchFind') return;
  const q = e.target.value.trim().toLowerCase();
  let any = false;
  document.querySelectorAll('#branchGroups [data-branch-group]').forEach((sec) => {
    let n = 0;
    sec.querySelectorAll('[data-branch]').forEach((li) => { const on = !q || li.dataset.branch.includes(q); li.hidden = !on; if (on) n++; });
    sec.querySelector('[data-branch-count]').textContent = nf(n);
    sec.hidden = n === 0;
    any = any || n > 0;
  });
  $('#branchNone').hidden = any;
});
