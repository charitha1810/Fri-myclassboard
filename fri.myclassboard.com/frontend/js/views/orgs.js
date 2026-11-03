/* Command Center: gateway-partner segments and the all-organisations payment-method table. */
import { D, S, INST, gatewayLabel } from '../store.js';
import { esc, nf, cr, rs, pct, sum, lakh, range } from '../format.js';
import { SEGMENTS, SEG, SEG_HELP, MODE_GROUPS, groupModes, mixBar, mixLegend, BRANCH_STATUS, COVERAGE, COV, branchCell, branchesTotal, gatewayUsage, labeledBar, segName } from '../segments.js';
import { pal } from '../chart.js';
import { T, pick } from '../lang.js';
import { $, fill } from '../ui.js';
import { registerList } from './instPopup.js';
import { previewExport } from '../exportPreview.js';

const PAGE = 50;
export const ORG = { seg: 'all', q: '', sort: 'total', page: 1 };

/** Per-institute FY figures used by both sections. */
function rows() {
  return INST().map((x) => {
    const g = groupModes(x.fy_modes);
    const total = sum(Object.values(x.fy_modes));
    return { x, g, total, share: total ? g.pg / total : 0, txns: x.fy_txns };
  });
}

function segmentChip(x) {
  const s = SEG[x.partner_status];
  return s ? `<span class="chip chip-${s.tone}" title="${esc(SEG_HELP[x.partner_status])}">${segName(x.partner_status, true)}</span>` : '';
}

export function renderSegments() {
  fill('.fyRangeLbl', range(D.modes.months));
  const all = rows();
  const segs = SEGMENTS.map(([key]) => {
    const list = all.filter((r) => r.x.partner_status === key);
    const g = Object.fromEntries(MODE_GROUPS.map((m) => [m[0], sum(list.map((r) => r.g[m[0]]))]));
    const total = sum(list.map((r) => r.total)), txns = sum(list.map((r) => r.txns));
    return { key, s: SEG[key], n: list.length, g, total, txns, online: g.pg };
  }).filter((s) => s.n);
  const nAll = sum(segs.map((s) => s.n)), totAll = sum(segs.map((s) => s.total));

  $('#segMixLegend').innerHTML = mixLegend(true);
  $('#segBar').innerHTML = labeledBar(segs.map((s) => ({
    label: pick(s.s.short, s.s.adv[1]), value: s.n, color: s.s.color(), list: 'seg:' + s.key, rank: 'seg:' + s.key,
    text: `${pick(s.s.short, s.s.adv[1])}:${nf(s.n)} schools (${pct(100 * s.n / nAll, 0)})`,
    keyText: `${nf(s.n)} schools (${pct(100 * s.n / nAll, 0)})`, tip: `${nf(s.n)} of ${nf(nAll)} schools`
  })));
  // Each tile opens a pop-up listing its schools (biggest fees first) instead of leaving the page.
  segs.forEach((s) => registerList('seg:' + s.key, segName(s.key), all.filter((r) => r.x.partner_status === s.key).sort((a, b) => b.total - a.total).map((r) => r.x), 'biggest fees first'));
  $('#segTiles').innerHTML = segs.filter((s) => s.key !== 'unknown').map((s) => `<div class="col"><a class="tile-link h-100 ${s.key === 'na' ? 'warn' : ''}" href="#command" data-list-popup="seg:${s.key}" title="${esc(SEG_HELP[s.key])}">
      <span class="fs-7 text-muted-2 d-flex align-items-center gap-2"><i class="sw" style="background:${s.s.color()}"></i>${segName(s.key)}</span>
      <span class="d-flex align-items-baseline gap-2"><b class="fs-4">${nf(s.n)}</b><span class="fs-8 text-muted-2">institutes — ${pct(100 * s.n / nAll, 0)} of all ${nf(nAll)}</span></span>
      <span class="fs-7">${T('Fees collected', 'Collections')}: <b>${cr(s.total / 1e7, 0)}</b></span>
      <span class="fs-7">${T('Paid online through MCB gateway', 'MCB PG volume')}: <b class="${s.key === 'partner' ? 'text-violet' : ''}">${cr(s.online / 1e7, 0)} (${pct(s.total ? 100 * s.online / s.total : 0)})</b></span>
      <span class="fs-8 text-muted-2">${T('Paid outside it (cash, cheque, card, bank)', 'Non-PG (offline + NEFT/UPI)')}: ${cr((s.total - s.online) / 1e7, 0)} (${pct(s.total ? 100 * (s.total - s.online) / s.total : 0)})</span>
      <span class="fs-8 text-muted-2 adv-only">Txns ${lakh(s.txns)} · avg ticket ${rs(s.txns ? s.total / s.txns : 0)} · ${pct(totAll ? 100 * s.total / totAll : 0)} of GMV</span>
    </a></div>`).join('');

  const td = (v, tot) => `<td class="text-end tnum">${cr(v / 1e7, 1)}<div class="fs-8 text-muted-2" title="Share of this group's fees">${pct(tot ? 100 * v / tot : 0)} of its fees</div></td>`;
  $('#segRows').innerHTML = segs.map((s) => `<tr>
      <td class="fw-semibold" style="min-width:250px"><span class="d-flex align-items-center gap-2"><i class="sw" style="background:${s.s.color()}"></i>${segName(s.key)}</span><div class="fs-8 text-muted-2 fw-normal simple-only">${esc(SEG_HELP[s.key])}</div></td>
      <td class="text-end tnum">${nf(s.n)}</td>
      <td class="text-end tnum fw-semibold">${cr(s.total / 1e7, 0)}<div class="fs-8 text-muted-2 fw-normal">${pct(totAll ? 100 * s.total / totAll : 0)} of all fees</div></td>
      <td style="min-width:200px">${mixBar(s.g, 12)}</td>
      ${MODE_GROUPS.map((m) => td(s.g[m[0]], s.total)).join('')}
      <td class="text-end tnum">${lakh(s.txns)}</td><td class="text-end tnum">${rs(s.txns ? s.total / s.txns : 0)}</td></tr>`).join('');
}

/** Branch coverage card: branch totals, institute tiles by coverage, and the partly-covered institutes. */
export function renderBranchCoverage() {
  const P = pal();
  const all = rows();
  const tot = Object.fromEntries(BRANCH_STATUS.map(([k]) => [k, sum(all.map((r) => r.x.branch_mix[k] || 0))]));
  const nBranches = sum(Object.values(tot));
  $('#brLegend').innerHTML = '';
  $('#brTotal').textContent = `${nf(nBranches)} branches in total · ${nf(tot.partner + tot.non_partner)} use an MCB gateway (${pct(nBranches ? 100 * (tot.partner + tot.non_partner) / nBranches : 0, 0)}) · ${nf(tot.na)} don't`;
  const BR_SHORT = { partner: 'Our partner gateway', non_partner: 'Other gateway', na: 'No MCB gateway', none: 'No information' };
  $('#brBar').innerHTML = labeledBar(BRANCH_STATUS.map(([k, , c]) => ({
    label: BR_SHORT[k], value: tot[k] || 0, color: P[c], rank: 'br:' + k,
    text: `${BR_SHORT[k]}: ${nf(tot[k] || 0)} branches (${pct(nBranches ? 100 * (tot[k] || 0) / nBranches : 0, 0)})`,
    keyText: `${nf(tot[k] || 0)} branches (${pct(nBranches ? 100 * (tot[k] || 0) / nBranches : 0, 0)})`
  })));

  $('#covTiles2').innerHTML = COVERAGE.map(([k]) => {
    const list = all.filter((r) => r.x.branch_coverage === k);
    if (!list.length) return '';
    const t = sum(list.map((r) => r.total)), pg = sum(list.map((r) => r.g.pg));
    const br = sum(list.map((r) => branchesTotal(r.x.branch_mix))), na = sum(list.map((r) => r.x.branch_mix.na || 0));
    registerList('cov:' + k, esc(COV[k].label), list.slice().sort((a, b) => b.total - a.total).map((r) => r.x), 'biggest fees first');
    return `<div class="col"><a class="tile-link h-100 ${k === 'partial' ? 'warn' : ''}" href="#command" data-list-popup="cov:${k}">
      <span class="fs-7 text-muted-2 d-flex align-items-center gap-2"><i class="sw" style="background:${COV[k].color()}"></i>${esc(COV[k].label)}</span>
      <span class="d-flex align-items-baseline gap-2"><b class="fs-4">${nf(list.length)}</b><span class="fs-8 text-muted-2">institutes${br ? ` · ${nf(br)} branches` : ''}${na && k === 'partial' ? ` · <b class="text-orange">${nf(na)} without MCB gateway</b>` : ''}</span></span>
      <span class="fs-7">Fees collected: <b>${cr(t / 1e7, 0)}</b></span>
      <span class="fs-7">Paid online through MCB gateway: <b>${pct(t ? 100 * pg / t : 0)}</b></span></a></div>`;
  }).join('');

  const partial = all.filter((r) => r.x.branch_coverage === 'partial').sort((a, b) => b.total - a.total);
  $('#brAll').textContent = `View all ${nf(partial.length)}`;
  $('#brRows').innerHTML = partial.slice(0, 10).map((r) => `<tr>
      <td style="min-width:240px"><a href="#institute/${encodeURIComponent(r.x.id)}" class="fw-650 text-reset text-decoration-none d-block">${esc(r.x.name)}</a>
        ${gatewayUsage(r.x)}</td>
      <td>${branchCell(r.x)}</td>
      <td class="text-end tnum fw-semibold">${rs(r.total)}</td>
      <td class="text-end tnum">${pct(r.share * 100)}</td>
      <td class="text-end tnum text-orange">${rs(r.g.cash + r.g.card + r.g.chq)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="text-center text-muted-2 py-3">Every mapped institute has all branches on the same footing.</td></tr>';
}

function orgFiltered() {
  const q = ORG.q.trim().toLowerCase();
  const list = rows().filter((r) => (ORG.seg === 'all' || r.x.partner_status === ORG.seg)
    && (!q || r.x.name.toLowerCase().includes(q) || r.x.db.toLowerCase().includes(q) || r.x.gateways.some((g) => g.toLowerCase().includes(q))));
  const k = ORG.sort;
  const val = (r) => k === 'total' ? r.total : k === 'share' ? r.share : k === 'txns' ? r.txns : k === 'na_br' ? (r.x.branch_mix.na || 0) : r.g[k];
  return list.sort((a, b) => val(b) - val(a));
}

export function renderOrgs() {
  const all = rows();
  const counts = Object.fromEntries(SEGMENTS.map(([k]) => [k, all.filter((r) => r.x.partner_status === k).length]));
  $('#orgSegs').innerHTML = [['all', 'All', all.length], ...SEGMENTS.filter(([k]) => counts[k]).map(([k, , short]) => [k, short, counts[k]])]
    .map(([k, l, n]) => `<button type="button" class="pill" aria-pressed="${ORG.seg === k}" data-org-seg="${k}">${esc(l)}<span class="count">${nf(n)}</span></button>`).join('');
  $('#orgLegend').innerHTML = mixLegend();
  $('#orgSort').value = ORG.sort;

  const list = orgFiltered();
  const shown = list.slice(0, ORG.page * PAGE);
  const money = (v) => v ? rs(v) : '<span class="text-faint">—</span>';
  $('#orgRows').innerHTML = shown.map((r) => {
    const x = r.x, gw = gatewayLabel(x);
    return `<tr>
      <td style="min-width:260px"><a href="#institute/${encodeURIComponent(x.id)}" class="fw-650 text-reset text-decoration-none d-block">${esc(x.name)}</a>
        ${gatewayUsage(x)}</td>
      <td>${segmentChip(x)}</td>
      <td class="text-end tnum fw-semibold">${rs(r.total)}</td>
      <td>${mixBar(r.g)}</td>
      ${MODE_GROUPS.map((m) => `<td class="text-end tnum ${m[0] === 'pg' ? 'text-violet' : m[0] === 'cash' ? 'text-orange' : ''}">${money(r.g[m[0]])}</td>`).join('')}
      <td class="text-end tnum">${nf(r.txns)}</td></tr>`;
  }).join('') || '<tr><td colspan="13" class="text-center text-muted-2 py-4">No organisations match.</td></tr>';
  $('#orgCount').textContent = `Showing ${nf(shown.length)} of ${nf(list.length)} organisations · ${rs(sum(list.map((r) => r.total)))} collected`;
  $('#orgMore').hidden = shown.length >= list.length;
  $('#orgMore').textContent = `Show ${nf(Math.min(PAGE, list.length - shown.length))} more`;
}

export function exportOrgs() {
  const head = ['Organisation', 'DB name', 'Organisation ID', 'Segment', 'Gateways', 'Branch coverage', 'Branches', 'Branches on partner gateway', 'Branches on non-partner gateway', 'Branches N/A',
    'Active students (all branches)', 'Students who paid (busiest month)', 'Collected (Rs)', ...MODE_GROUPS.map((g) => g[1] + ' (Rs)'), 'Online share %', 'Transactions'];
  const data = orgFiltered().map((r) => [r.x.name, r.x.db, r.x.org_id, (SEG[r.x.partner_status] || {}).label || '', r.x.gateways.join(' | '),
    (COV[r.x.branch_coverage] || {}).label || '', branchesTotal(r.x.branch_mix), r.x.branch_mix.partner || 0, r.x.branch_mix.non_partner || 0, r.x.branch_mix.na || 0,
    r.x.active_students ?? '', r.x.students, r.total.toFixed(2), ...MODE_GROUPS.map((g) => (r.g[g[0]] || 0).toFixed(2)), (r.share * 100).toFixed(1), r.txns]);
  previewExport('Export organisations by payment method', head, data, `organisations-payment-methods-${S.fy}.csv`);
}

export function bindOrgEvents() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-org-seg]');
    if (b) { ORG.seg = b.dataset.orgSeg; ORG.page = 1; renderOrgs(); }
  });
  let t = null;
  $('#orgSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { ORG.q = e.target.value; ORG.page = 1; renderOrgs(); }, 150); });
  $('#orgSort').addEventListener('change', (e) => { ORG.sort = e.target.value; ORG.page = 1; renderOrgs(); });
  $('#orgMore').addEventListener('click', () => { ORG.page += 1; renderOrgs(); });
  $('#orgExport').addEventListener('click', exportOrgs);
}
