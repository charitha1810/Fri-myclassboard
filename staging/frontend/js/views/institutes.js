/* VIEW 2 · INSTITUTES — every dropdown is filled from /api/filter-options. */
import { D, S, FILTER_DEFAULTS, rates, INST, gatewayLabel } from '../store.js';
import { esc, nf, rs, pct, sum, range } from '../format.js';
import { STATUS, PLAY_LABEL, playChip } from '../metrics.js';
import { pal } from '../chart.js';
import { $, $$, ic, chip, avatar, fill } from '../ui.js';
import { SEG, SEG_HELP, COV, MODE_GROUPS, groupModes, branchesOn, gatewayUsage, segName } from '../segments.js';
import { previewExport } from '../exportPreview.js';
import { accountText } from './instPopup.js';

const PAGE = 100;

export const VIEWS = [
  ['all', 'All institutes', () => true],
  ['nopg', 'Nothing paid online', (x) => x.status === 'nopg'],
  ['low', 'Under 10% paid online', (x) => x.status === 'low'],
  ['loan', 'High fees (loan / EMI fit)', (x) => x.loanFit],
  ['live', '10%+ paid online', (x) => x.status === 'live'],
  ['dormant', 'No recent fees', (x) => x.status === 'dormant']
];

export function instFiltered(ignoreView) {
  const q = S.q.trim().toLowerCase();
  const pred = (VIEWS.find((v) => v[0] === S.view) || VIEWS[0])[2];
  // Database, partner, coverage, gateway, school and months are already applied by the server (global filters).
  return INST().filter((x) => (ignoreView || pred(x))
    && (!q || x.name.toLowerCase().includes(q) || x.db.toLowerCase().includes(q) || accountText(x).includes(q)));
}

/** Build the filter selects from the API's option lists (called after each data load). */
export function fillFilterOptions() {
  const O = D.opts;
  $('#assignMenu').innerHTML = D.meta.owners.length
    ? D.meta.owners.map((o) => `<li><button class="dropdown-item" data-assign="${esc(o.id)}">${esc(o.name)} (${esc(o.id)})</button></li>`).join('') + '<li><hr class="dropdown-divider"></li><li><button class="dropdown-item" data-assign="">Unassign</button></li>'
    : '<li><span class="dropdown-item-text fs-7 text-muted-2">No owners configured.<br>Set MCB_OWNERS in backend/.env</span></li>';
  // School picker (shared datalist): every school in the FY, "Name — DB" so duplicates across tenants stay distinct.
  $('#schoolList').innerHTML = (O.institutes || []).map((o) => `<option value="${esc(o.label)}"></option>`).join('');
  $('#schoolPickHelp').textContent = `${nf((O.institutes || []).length)} schools with collections in FY ${D.meta.fy}.`;
}

/** Resolve picker text to a school {value: id, label}: exact label first, then a unique partial match. */
export function resolvePick(text) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const list = D.opts.institutes || [];
  const exact = list.find((o) => o.label.toLowerCase() === t);
  if (exact) return exact;
  const hits = list.filter((o) => o.label.toLowerCase().includes(t));
  return hits.length === 1 ? hits[0] : (hits.length ? hits : null);
}

export function resetFilters(view = 'all') {
  Object.assign(S, FILTER_DEFAULTS, { view, page: 1 });
}

function sortRows(rows) {
  const k = S.sort, dir = S.sortDir;
  return rows.sort((a, b) => (k === 'name' ? dir * a.name.localeCompare(b.name) : dir * (a[k] - b[k])) || b.score - a.score);
}

export function renderInstitutes() {
  const r = rates(), P = pal();
  const months = D.inst.months, win = range(months), annual = months.length ? 12 / months.length : 0;
  fill('.instRangeLbl', win);
  fill('.convLbl', D.settings.conv_pct + '%');
  fill('.takeLbl', pct(r.take * 100, 2));

  const base = instFiltered(true);
  $('#savedViews').innerHTML = VIEWS.map((v) => `<button type="button" class="pill" aria-pressed="${S.view === v[0]}" data-view-key="${v[0]}">${v[1]}<span class="count">${nf(base.filter(v[2]).length)}</span></button>`).join('');

  const rows = sortRows(instFiltered(false));
  const shown = rows.slice(0, S.page * PAGE);
  $$('.th-sort').forEach((b) => {
    const on = b.dataset.sort === S.sort;
    b.toggleAttribute('aria-sort', on);
    if (on) b.setAttribute('aria-sort', S.sortDir > 0 ? 'ascending' : 'descending');
    const label = b.textContent.trim();
    b.innerHTML = esc(label) + (on ? ic(S.sortDir > 0 ? 'caret-up-fill' : 'caret-down-fill') : '');
  });

  // One fact per place: branches + gateways under the name, online share (and what it means) in its column,
  // and a single plain chip for the institute's MCB-gateway status.
  const USAGE = { live: '', low: 'very little online', nopg: 'nothing online', dormant: 'no recent fees' };
  $('#instRows').innerHTML = shown.map((x) => {
    const sc = x.score >= 80 ? P.cash : x.score >= 60 ? P.card : P.oth;
    const sel = S.sel.has(x.id);
    const seg = SEG[x.partner_status];
    const usage = USAGE[x.status] || '';
    return `<tr class="${sel ? 'table-selected' : ''}">
      <td class="ps-3"><input class="form-check-input" type="checkbox" data-sel="${esc(x.id)}" ${sel ? 'checked' : ''} aria-label="Select ${esc(x.name)}"></td>
      <td style="min-width:260px"><a href="#institute/${encodeURIComponent(x.id)}" class="fw-650 text-reset text-decoration-none d-block">${esc(x.name)}</a>
        <span class="fs-8 text-muted-2">${x.branches ? `${x.branches} branch${x.branches === 1 ? '' : 'es'}` : ''}</span>
        <div class="fs-8 text-muted-2" data-am>Account manager: ${x.account_manager ? `<b class="text-body">${esc(x.account_manager)}</b>` : '<span class="text-faint">not assigned</span>'}</div>
        ${gatewayUsage(x)}</td>
      <td class="text-end tnum" title="Highest number of students who paid in any one month">${nf(x.students)}</td>
      <td class="text-end tnum fw-semibold">${rs(x.tot)}</td>
      <td><div class="mini-split" role="img" aria-label="${pct(x.share * 100)} online"><div style="width:${(100 * x.share).toFixed(1)}%;background:${P.pg}"></div><div style="flex:1;background:${x.tot ? P.cash : 'transparent'}"></div></div>
        <span class="fs-8 text-muted-2">${x.tot ? `<span class="text-violet fw-semibold">${pct(x.share * 100, 0)} online</span> · ${pct(100 - x.share * 100, 0)} other ways` : 'No fees in this period'}${usage ? ` · <span class="${x.status === 'dormant' ? '' : 'text-orange'}">${usage}</span>` : ''}</span></td>
      <td>${seg ? `<span class="chip chip-${seg.tone}" title="${esc(SEG_HELP[x.partner_status] || '')}">${segName(x.partner_status, true)}</span>` : ''}</td>
      <td>${x.loanFit ? chip('Yes', 'blue', `${rs(x.perStu)} per student: high enough to offer a loan / EMI`) : '<span class="text-faint">No</span>'}</td>
      <td title="0–100: higher = bigger chance to grow online payments"><div class="d-flex align-items-center gap-2"><b class="tnum" style="width:24px">${x.score}</b><div class="score-track"><div class="score-fill" style="width:${x.score}%;background:${sc}"></div></div></div></td>
      <td class="text-end"><div class="d-flex flex-column align-items-end"><b class="text-orange tnum">${rs(x.off)}</b><span class="fs-8 text-muted-2 tnum" title="Commission per year if ${D.settings.conv_pct}% of this moves online">+${rs(x.revYr)}/yr for MCB</span></div></td>
      <td>${playChip(x.play)}</td>
      <td class="pe-3">${avatar(x.owner)}</td></tr>`;
  }).join('');
  $('#instEmpty').hidden = rows.length > 0;
  $('#instMoreWrap').hidden = shown.length >= rows.length;
  $('#instMore').textContent = `Show ${nf(Math.min(PAGE, rows.length - shown.length))} more`;
  $('#instCount').textContent = `Showing ${nf(shown.length)} of ${nf(rows.length)} matching · ${nf(D.inst.institutes.length)} institutes in FY ${S.fy}`;

  const tTot = sum(rows.map((x) => x.tot)), tPg = sum(rows.map((x) => x.pg)), tOff = sum(rows.map((x) => x.off));
  $('#instTotals').innerHTML = [
    ['Institutes', nf(rows.length), ''], ['Students who paid (busiest month)', nf(sum(rows.map((x) => x.students))), ''], ['Fees collected, ' + win, rs(tTot), ''],
    ['Paid online through MCB', rs(tPg) + (tTot ? ` (${pct(100 * tPg / tTot)})` : ''), 'text-violet'], ['Paid offline (cash, card, cheque, DD)', rs(tOff), 'text-orange'],
    ['Paid other ways (bank transfer, auto-debit, loan…)', rs(Math.max(0, tTot - tPg - tOff)), ''],
    [`Extra MCB commission / yr if ${D.settings.conv_pct}% moves online`, rs(tOff * annual * r.conv * r.take), 'text-violet']
  ].map((t) => `<div><div class="fs-8 text-muted-2">${esc(t[0])}</div><div class="v ${t[2]}">${t[1]}</div></div>`).join('');

  const allSel = rows.length > 0 && rows.every((x) => S.sel.has(x.id));
  $('#selAll').checked = allSel;
  $('#selAll').indeterminate = !allSel && rows.some((x) => S.sel.has(x.id));
  const selOff = sum(INST().filter((x) => S.sel.has(x.id)).map((x) => x.off));
  $('#bulkBar').hidden = S.sel.size === 0;
  $('#bulkText').textContent = `${nf(S.sel.size)} selected · ${rs(selOff)} offline`;
}

export function exportCsv() {
  const rows = sortRows(instFiltered(false));
  const fyRange = range(D.modes.months);   // payment-method columns cover the selected months, like the Command Center
  const head = ['Institute', 'Branches',
    'Students who paid (busiest month)', `Paid online via MCB ${range(D.inst.months)} (Rs)`, `Paid offline ${range(D.inst.months)} (Rs)`,
    'Paid online %', 'Online payment level', 'Gateway', 'Branch coverage', 'Branches with MCB gateway', 'Branches without MCB gateway', 'Gateway names', 'High fees (loan / EMI fit)', 'Opportunity (0-100)', 'Suggested next step', 'Owner',
    `Total collected ${fyRange} (Rs)`, ...MODE_GROUPS.map((g) => `${g[1]} ${fyRange} (Rs)`)];
  const data = rows.map((x) => {
    const g = groupModes(x.fy_modes);
    return [x.name, x.branches,
      x.students, x.pg.toFixed(2), x.off.toFixed(2), (x.share * 100).toFixed(1),
      STATUS[x.status][0], (SEG[x.partner_status] || {}).label || '', (COV[x.branch_coverage] || {}).label || '', branchesOn(x.branch_mix), x.branch_mix.na || 0, gatewayLabel(x) || '', x.loanFit ? 'Yes' : 'No', x.score, PLAY_LABEL[x.play] || x.play, x.owner,
      sum(Object.values(x.fy_modes)).toFixed(2), ...MODE_GROUPS.map((m) => (g[m[0]] || 0).toFixed(2))];
  });
  previewExport('Export institutes', head, data, `institutes-${S.fy}.csv`);
}
