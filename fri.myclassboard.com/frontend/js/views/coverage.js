/* VIEW 4 · GATEWAYS & LOANS */
import { registerList, openMonthPopup } from './instPopup.js';
import { D, S, INST } from '../store.js';
import { esc, nf, cr, rs, crAxis, pct, sum, lakh, growth, fullMonth, range, yearOf } from '../format.js';
import { drawChart, pal, tipRow } from '../chart.js';
import { $, ic, chip, fill } from '../ui.js';
import { SEGMENTS, SEG, SEG_HELP, segName, groupModes, mixBar, mixLegend, GW_KIND, gwKindChip } from '../segments.js';

export const MASTER = { kind: 'all' };

/** Gateway master: gateways in use (inactive ones are left out by the server), with usage under the current filters. */
export function renderMaster() {
  const rows = D.gmaster || [];
  const count = (k) => rows.filter((r) => k === 'all' || r.kind === k).length;
  $('#masterKinds').innerHTML = [['all', 'All'], ...Object.entries(GW_KIND).map(([k, v]) => [k, v[0]])]
    .map(([k, l]) => `<button type="button" class="pill" aria-pressed="${MASTER.kind === k}" data-master-kind="${k}">${esc(l)}<span class="count">${count(k)}</span></button>`).join('');
  const list = rows.filter((r) => MASTER.kind === 'all' || r.kind === MASTER.kind);
  // The "Schools" number opens the schools mapped to the gateway (whether or not they paid online through it).
  const byIdM = new Map(INST().map((x) => [x.id, x]));
  rows.forEach((r) => registerList('gwmaster:' + r.name, `${esc(r.name)}: schools mapped to this gateway`,
    (r.institute_ids || []).map((id) => byIdM.get(id)).filter(Boolean).sort((a, b) => sum(Object.values(b.fy_modes)) - sum(Object.values(a.fy_modes))),
    `${nf(r.branches)} branch${r.branches === 1 ? '' : 'es'} mapped · biggest fees first`,
    (x) => { const bg = (x.branch_gateways || []).find((b) => b.gateway === r.name); return bg ? `Branches on ${esc(r.name)}: <b>${nf(bg.branches.length)}</b> of ${nf(x.branches || bg.branches.length)}` : ''; }));
  const yn = (v) => v === null || v === undefined ? '<span class="text-faint">—</span>' : v ? '<b class="text-green">Yes</b>' : '<span class="text-muted-2">No</span>';
  const total = D.gw.summary.fytd || 1;
  $('#masterRows').innerHTML = list.map((r) => `<tr class="${r.kind === 'inactive' ? 'text-muted-2' : ''}">
      <td class="fw-semibold">${esc(r.name)}${r.id != null ? `<div class="fs-8 text-muted-2 fw-normal font-mono">ID ${r.id}</div>` : ''}</td>
      <td>${gwKindChip(r.kind)}</td>
      <td class="text-center">${yn(r.active)}</td><td class="text-center">${yn(r.partner)}</td><td class="text-center">${yn(r.commission_sharing)}</td>
      <td class="text-end tnum">${r.institutes ? `<a href="#coverage" class="text-reset fw-semibold" data-list-popup="gwmaster:${esc(r.name)}" title="Click to list these schools">${nf(r.institutes)}</a>` : '<span class="text-faint">0</span>'}</td>
      <td class="text-end tnum">${r.branches ? nf(r.branches) : '<span class="text-faint">0</span>'}</td>
      <td class="text-end tnum">${r.volume ? cr(r.volume, 1) + `<div class="fs-8 text-muted-2">${pct(100 * r.volume / total)}</div>` : '<span class="text-faint">—</span>'}</td>
      <td class="text-end tnum">${r.txns ? nf(r.txns) : '<span class="text-faint">—</span>'}</td>
      <td class="text-end tnum">${r.last_month ? cr(r.last_month, 1) : '<span class="text-faint">—</span>'}</td>
      <td class="text-end tnum fw-semibold ${r.mom_pct === null ? 'text-faint' : r.mom_pct >= 0 ? 'text-violet' : 'text-orange'}">${r.mom_pct === null ? '—' : (r.mom_pct >= 0 ? '+' : '−') + pct(Math.abs(r.mom_pct))}</td></tr>`).join('')
    || '<tr><td colspan="11" class="text-center text-muted-2 py-3">No gateways with this status.</td></tr>';
}

const PSEUDO = new Set(['Mapping not readable', 'No gateway mapping', 'No MCB gateway']);

export function renderCoverage() {
  const P = pal();
  const G = D.gw.summary, months = G.months, li = months.length - 1;
  const total = sum(D.modes.month_totals);
  fill('.fyRangeLbl', range(months));
  fill('.lastMonLbl', fullMonth(months[li] || ''));
  fill('.lastMonShort', months[li] || '');
  fill('.prevMonLbl', fullMonth(months[li - 1] || ''));

  // ---- Gateway KPIs: total, partner, non-partner, institutes not using MCB gateways ----
  const mom = growth(G.monthly[li], G.monthly[li - 1]);
  const segSum = (k) => sum(G.by_segment[k] || []);
  const inst = INST();
  const instOf = (k) => inst.filter((x) => x.partner_status === k);
  const fyTot = (list) => sum(list.map((x) => sum(Object.values(x.fy_modes))));
  const pV = segSum('partner'), nV = segSum('non_partner');
  const naList = instOf('na');
  // Each KPI box opens a pop-up listing its schools (biggest first) instead of leaving the page.
  const byPg = (l) => l.slice().sort((a, b) => b.pg - a.pg);
  registerList('gw:all', 'All online fees via MCB gateways', byPg(inst.filter((x) => x.pg > 0)), 'biggest online fees first');
  registerList('gw:partner', 'Through our partner gateways', byPg(instOf('partner')), 'biggest online fees first');
  registerList('gw:non_partner', 'Through gateways that are not our partner', byPg(instOf('non_partner')), 'biggest online fees first');
  registerList('gw:na', "Schools that don't use any MCB gateway", instOf('na').sort((a, b) => b.tot - a.tot), 'biggest total fees first');
  $('#gwSec').innerHTML = [
    ['All online fees via MCB gateways, ' + range(months), cr(G.fytd), `${pct(total ? 100 * G.fytd / total : 0)} of all fees · ${lakh(G.fytd_txns)} payments`, 'text-violet', mom === null ? '' : `${fullMonth(months[li])}: ${(mom >= 0 ? '+' : '−') + pct(Math.abs(mom))} compared with ${fullMonth(months[li - 1])}`, 'all'],
    ['Through our partner gateways', cr(pV), `${pct(G.fytd ? 100 * pV / G.fytd : 0)} of online fees · ${nf(instOf('partner').length)} institutes`, 'text-violet', 'We earn commission on this', 'partner'],
    ['Through gateways that are not our partner', cr(nV), `${pct(G.fytd ? 100 * nV / G.fytd : 0)} of online fees · ${nf(instOf('non_partner').length)} institutes`, 'text-blue', 'No commission: switch them to a partner', 'non_partner'],
    ["Schools that don't use any MCB gateway", nf(naList.length) + ' institutes', `${cr(fyTot(naList) / 1e7)} in fees, all collected outside MCB`, 'text-orange', 'Sell them the MCB gateway', 'na']
  ].map((k) => `<div class="col"><a class="card h-100 text-reset text-decoration-none${k[5] === 'na' ? '' : ''}" href="#coverage" data-list-popup="gw:${k[5]}" ${k[5] === 'na' ? 'style="background:var(--mcb-orange-soft);border-color:var(--mcb-orange-line)"' : ''}><div class="card-body py-3"><div class="kpi-label">${esc(k[0])}</div><div class="kpi-value mt-1 ${k[3]}">${k[1]}</div><div class="kpi-sub mt-1">${esc(k[2])}</div>${k[4] ? `<div class="fs-8 fw-semibold mt-1 ${k[3]}">${esc(k[4])}</div>` : ''}</div></a></div>`).join('');

  // ---- Monthly volume stacked by partner segment ----
  const segSeries = SEGMENTS.filter(([k]) => (G.by_segment[k] || []).some((v) => v > 0))
    .map(([k, label]) => ({ name: label, color: SEG[k].color(), values: G.by_segment[k] }));
  $('#pgLegend').innerHTML = segSeries.map((s) => `<span><i class="sw" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  drawChart('pgChart', {
    onClick: (i) => openMonthPopup({ kind: 'pg', month: months[i] }),
    height: 260, labels: months, yFmt: crAxis,
    series: segSeries.length ? segSeries : [{ name: 'Gateway volume', color: P.pg, values: G.monthly }],
    capAll: true, capFmt: (v) => cr(v, 0),
    segFmt: (v, s, i, t) => (t && v / t >= 0.08 ? Math.round(100 * v / t) + '%' : ''),
    aria: (i) => months[i] + ': ' + cr(G.monthly[i], 1),
    tip: (i) => `<b>${months[i]} ${yearOf(months[i], S.fy)}</b>` + segSeries.slice().reverse().map((s) => tipRow(s.color, s.name, cr(s.values[i], 1) + ' · ' + pct(G.monthly[i] ? 100 * s.values[i] / G.monthly[i] : 0, 0))).join('') + `<div class="ft">Total ${cr(G.monthly[i], 1)} · ${nf(G.txns[i])} transactions</div>`
  });

  // ---- Partner vs non-partner comparison ----
  const cmp = SEGMENTS.filter(([k]) => instOf(k).length && k !== 'unknown').map(([k]) => {
    const list = instOf(k);
    const g = list.reduce((acc, x) => { const m = groupModes(x.fy_modes); Object.keys(m).forEach((key) => { acc[key] = (acc[key] || 0) + m[key]; }); return acc; }, {});
    const tot = fyTot(list), tx = G.segment_txns[k] || 0, vol = segSum(k) * 1e7;
    const s = G.by_segment[k] || [];
    return { k, n: list.length, tot, vol, tx, g, last: s[li] || 0, mom: growth(s[li], s[li - 1]), offline: (g.cash || 0) + (g.card || 0) + (g.chq || 0) };
  });
  const cols = [
    ['Institutes', (c) => nf(c.n)],
    ['Total fees collected', (c) => cr(c.tot / 1e7, 0)],
    ['Paid online through MCB gateway', (c) => cr(c.vol / 1e7, 1)],
    ['% of fees paid online through MCB', (c) => pct(c.tot ? 100 * c.vol / c.tot : 0)],
    ['Number of online payments', (c) => lakh(c.tx)],
    ['Average online payment', (c) => c.tx ? rs(c.vol / c.tx) : '—'],
    ['Paid online in ' + fullMonth(months[li] || '') + ' (change vs previous month)', (c) => cr(c.last, 1) + (c.mom === null ? '' : ` <span class="fs-8 ${c.mom >= 0 ? 'text-violet' : 'text-orange'}">${c.mom >= 0 ? '+' : '−'}${pct(Math.abs(c.mom))}</span>`)],
    ['Still paid offline (cash, card, cheque, DD)', (c) => `<span class="text-orange">${cr(c.offline / 1e7, 0)}</span>`],
    ['How they pay (colours below)', (c) => `<div style="min-width:160px">${mixBar(c.g)}</div>`]
  ];
  $('#cmpHead').innerHTML = `<tr><th scope="col"></th>${cmp.map((c) => `<th scope="col" class="text-end" title="${esc(SEG_HELP[c.k] || '')}"><span class="d-inline-flex align-items-center gap-2"><i class="sw" style="background:${SEG[c.k].color()}"></i>${segName(c.k)}</span></th>`).join('')}</tr>`;
  $('#cmpLegend').innerHTML = mixLegend(true);
  $('#cmpRows').innerHTML = cols.map(([label, f]) => `<tr><th scope="row" class="fw-semibold" style="min-width:240px">${esc(label)}</th>${cmp.map((c) => `<td class="text-end tnum">${f(c)}</td>`).join('')}</tr>`).join('');

  const SIG = { data: ['var(--mcb-red-soft)', 'text-danger', 'Data check'], churn: ['var(--mcb-orange-soft)', 'text-orange', 'Falling'], growth: ['var(--mcb-violet-soft)', 'text-violet', 'Growing'], emi: ['var(--mcb-blue-soft)', 'text-blue', 'EMI demand'] };
  $('#gwSignals').innerHTML = D.gw.signals.map((s) => { const t = SIG[s.kind]; return `<div class="signal-row" style="background:${t[0]}"><b class="${t[1]}">${t[2]}</b><span>${esc(s.text)}</span></div>`; }).join('')
    || '<div class="text-muted-2 fs-7">No notable movements this month.</div>';

  // ---- Leaderboard ----
  const gws = D.gw.gateways.filter((g) => g.kind !== 'inactive').filter((g) => S.gwSeg === 'all' || (S.gwSeg === 'partner' ? g.is_partner === true : !PSEUDO.has(g.name) && g.is_partner !== true)).sort((a, b) => {
    if (PSEUDO.has(a.name) !== PSEUDO.has(b.name)) return PSEUDO.has(a.name) ? 1 : -1;
    if (S.gwSort === 'growth') return (b.mom_pct ?? -999) - (a.mom_pct ?? -999);
    if (S.gwSort === 'ticket') return b.avg_ticket - a.avg_ticket;
    return b.volume - a.volume;
  });
  const maxVol = Math.max(1e-9, ...gws.map((g) => g.volume));
  // "N institutes" under a gateway opens those schools, with the online fees credited to the gateway for each.
  const byIdG = new Map(inst.map((x) => [x.id, x]));
  D.gw.gateways.forEach((g) => {
    const paid = new Map((g.schools || []).map((s) => [s.id, s]));
    registerList('gateway:' + g.name, `${esc(g.name)}: schools with online fees through this gateway`,
      (g.schools || []).map((s) => byIdG.get(s.id)).filter(Boolean), `${cr(g.volume, 2)} online fees, ${nf(g.txns)} payments · biggest first`,
      (x) => { const s = paid.get(x.id); return s ? `Online fees credited to ${esc(g.name)}: <b class="text-violet" title="₹${nf(s.amount_rs, 2)}">${rs(s.amount_rs)}</b> in <b>${nf(s.txns)}</b> payment${s.txns === 1 ? '' : 's'}`
        + (s.gateways > 1 ? ` <span class="text-muted-2">· split equally between its ${s.gateways} gateways</span>` : '') : ''; });
  });
  const tone = (n) => n.startsWith('Identical') ? 'red' : (n.startsWith('Falling') || n.startsWith('No ') || n.startsWith('Tenant') || n.startsWith('Own')) ? 'orange' : n.startsWith('High') ? 'blue' : n.startsWith('Spike') ? 'violet' : 'gray';
  $('#gwRows').innerHTML = gws.map((g) => `<tr${PSEUDO.has(g.name) ? ' class="text-muted-2"' : ''}>
    <td class="fw-semibold">${esc(g.name)}<div class="fs-8 fw-normal"><a href="#coverage" class="text-muted-2" data-list-popup="gateway:${esc(g.name)}" title="Click to list these schools">${nf(g.institutes)} institute${g.institutes === 1 ? '' : 's'}</a></div></td>
    <td>${PSEUDO.has(g.name) ? '' : gwKindChip(g.kind)}</td>
    <td class="text-end tnum">${cr(g.volume, 1)}</td>
    <td><div class="d-flex align-items-center gap-2"><div class="progress flex-grow-1" role="progressbar" aria-label="${esc(g.name)} share" aria-valuenow="${(100 * g.volume / (G.fytd || 1)).toFixed(1)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${Math.max(0.5, 100 * g.volume / (G.fytd || 1)).toFixed(1)}%;background:${PSEUDO.has(g.name) ? P.oth : P.pg}"></div></div><span class="tnum text-end" style="width:44px">${pct(100 * g.volume / (G.fytd || 1))}</span></div></td>
    <td class="text-end tnum">${nf(g.txns)}</td><td class="text-end tnum">${rs(g.avg_ticket)}</td><td class="text-end tnum">${g.last_month ? cr(g.last_month, g.last_month < 1 ? 2 : 1) : '—'}</td>
    <td class="text-end tnum fw-semibold ${g.mom_pct === null ? 'text-faint' : g.mom_pct >= 0 ? 'text-violet' : 'text-orange'}">${g.mom_pct === null ? '—' : `${ic(g.mom_pct >= 0 ? 'caret-up-fill' : 'caret-down-fill')} ${pct(Math.abs(g.mom_pct))}`}</td>
    <td>${g.note ? chip(g.note, tone(g.note)) : ''}</td></tr>`).join('');
  $('#gwRest').textContent = G.attributed
    ? 'How this is worked out: each school\'s online fees are credited to the gateway(s) it uses. A school with two gateways has its online fees split equally between them. Totals match the payment-mode figures.'
    : '';

}

/** Loan partners view: loan payments, partner scorecard and the "what to sell to whom" matrix. */
export function renderLoans() {
  const P = pal();
  const inst = INST();
  fill('.fyRangeLbl', range(D.loans.summary.months));
  // ---- Loans (Loan Payments fee mode) ----
  const Lo = D.loans.summary, lli = Lo.months.length - 1;
  $('#loanSecSub').textContent = D.loans.partners.length
    ? `Fees parents paid through education loans, ${range(Lo.months)}, and the loan / EMI partners behind them.`
    : Lo.source === 'fee_ledger'
    ? `Fees parents paid through education loans, ${range(Lo.months)}. Loan partner details are not connected yet.`
    : `Disbursals ${range(Lo.months)}`;
  const lmom = growth(Lo.amount[lli], Lo.amount[lli - 1]);
  const partners = D.loans.partners;
  const loanFit = INST().filter((x) => x.loanFit).length;
  $('#loanKpis').innerHTML = [
    ['Fees paid by loan, ' + range(Lo.months), cr(Lo.fytd), nf(Lo.fytd_txns) + ' payments', '', ''],
    ['Average loan payment', rs(Lo.fytd_txns ? Lo.fytd * 1e7 / Lo.fytd_txns : 0), 'Per payment', '', ''],
    ['Paid by loan in ' + fullMonth(Lo.months[lli] || ''), cr(Lo.amount[lli] || 0, 2), lmom === null ? '' : (lmom >= 0 ? '+' : '−') + pct(Math.abs(lmom), 0) + ' compared with ' + fullMonth(Lo.months[lli - 1] || ''), '', ''],
    ['Schools with high fees (loan / EMI fit)', nf(loanFit), `₹35,000 or more per student, ${range(D.inst.months)}`, 'text-blue', 'warn']
  ].map((k) => `<div class="col"><div class="card h-100"${k[4] ? ' style="background:var(--mcb-blue-soft);border-color:transparent"' : ''}><div class="card-body py-3"><div class="kpi-label">${esc(k[0])}</div><div class="kpi-value mt-1 ${k[3]}">${k[1]}</div><div class="kpi-sub mt-1">${esc(k[2])}</div></div></div></div>`).join('');
  $('#loanChartSub').textContent = 'Column height = fees paid through education loans that month. Hover for the number of payments; click a month to see the schools behind it.';
  drawChart('loanChart', {
    onClick: (i) => openMonthPopup({ kind: 'loan', month: Lo.months[i] }),
    height: 260, labels: Lo.months, yFmt: crAxis,
    series: [{ name: 'Loan payments', color: P.loan, values: Lo.amount }],
    capAll: true, capFmt: (v) => cr(v, 1),
    aria: (i) => Lo.months[i] + ': ' + cr(Lo.amount[i], 2),
    tip: (i) => `<b>${Lo.months[i]} ${yearOf(Lo.months[i], S.fy)}</b>` + tipRow(P.loan, 'Loan payments', cr(Lo.amount[i], 2)) + `<div class="ft">${nf(Lo.txns[i])} payments</div>`
  });
  // ---- Partner scorecard: financing sources from the database, reconciled by the server to the fee ledger so the
  //      total row equals "Fees paid by loan" (partners + schools with no partner recorded + recording difference) ----
  const LN = D.loans, totalDisb = LN.partners_total_rs || 0, ledger = LN.ledger_total_rs || 0;
  const noPartner = (LN.unassigned_institutes || []).map((id) => inst.find((x) => x.id === id)).filter(Boolean);
  registerList('loan:nopartner', 'Loan payments with no partner recorded', noPartner, 'biggest loan payments first');
  const signed = (v, f) => (v < 0 ? '−' : v > 0 ? '+' : '') + f(Math.abs(v));
  // Each partner's "Institutes" number opens its schools: what each paid through the partner, and its usual details.
  const byId = new Map(inst.map((x) => [x.id, x]));
  partners.forEach((p) => {
    const paid = new Map((p.schools || []).map((s) => [s.id, s]));
    registerList('partner:' + p.name, `${esc(p.name)}: schools mapped to this loan partner`,
      (p.schools || []).map((s) => byId.get(s.id)).filter(Boolean),
      `${nf(p.active_institutes)} with loans (${rs(p.disbursed_rs)}, ${nf(p.loans || 0)} payments) · biggest first`,
      (x) => { const s = paid.get(x.id); return s && (s.loans || s.amount_rs)
        ? `Paid through ${esc(p.name)}: <b class="text-violet" title="₹${nf(s.amount_rs, 2)}">${rs(s.amount_rs)}</b> in <b>${nf(s.loans)}</b> loan payment${s.loans === 1 ? '' : 's'}`
        : `<span class="text-orange">Mapped to ${esc(p.name)}, no loan payment in these months</span>`; });
  });
  const partnerRows = partners.map((p) => {
    const sh = ledger && p.disbursed_rs ? 100 * p.disbursed_rs / ledger : 0;
    const st = !p.loans ? chip('No loans this year', 'orange', 'Mapped to schools, but no loan payment came through it in these months')
      : sh < 1 ? chip('Barely used', 'amber', 'Under 1% of all fees paid by loan') : chip('Active · ' + pct(sh), 'green', 'Share of all fees paid by loan');
    return `<tr><td class="fw-semibold">${esc(p.name)}${p.in_use ? '' : ' <span class="fs-8 text-muted-2 fw-normal">(switched off)</span>'}</td>
      <td class="text-end tnum"><a href="#loans" class="text-reset fw-semibold" data-list-popup="partner:${esc(p.name)}" title="Click to list these schools">${nf(p.institutes)}<div class="fs-8 text-muted-2 fw-normal">${nf(p.active_institutes)} with loans · click to list</div></a></td>
      <td class="text-end tnum" title="₹${nf(p.disbursed_rs, 2)}">${p.loans ? rs(p.disbursed_rs) : '—'}</td>
      <td class="text-end tnum">${p.loans ? nf(p.loans) : '—'}</td><td>${st}</td></tr>`;
  }).join('');
  const extraRows = (LN.unassigned_rs || LN.unassigned_loans ? `<tr id="loanNoPartner" style="background:var(--mcb-orange-soft)">
      <td class="fw-semibold"><a href="#loans" class="text-reset" data-list-popup="loan:nopartner" title="Click to list these schools">No partner recorded</a><div class="fs-8 text-muted-2 fw-normal">Loan payments in the fee ledger, at schools with no partner transactions</div></td>
      <td class="text-end tnum"><a href="#loans" class="text-reset fw-semibold" data-list-popup="loan:nopartner">${nf(noPartner.length)}</a><div class="fs-8 text-muted-2">click to list</div></td>
      <td class="text-end tnum" title="₹${nf(LN.unassigned_rs, 2)}">${rs(LN.unassigned_rs)}</td><td class="text-end tnum">${nf(LN.unassigned_loans)}</td>
      <td>${chip(pct(ledger ? 100 * LN.unassigned_rs / ledger : 0) + ' of loan fees', 'orange', 'Share of all fees paid by loan that has no partner on record')}</td></tr>` : '')
    + (Math.abs(LN.difference_rs || 0) >= 0.005 || LN.difference_loans ? `<tr id="loanDifference" class="text-muted-2">
      <td>Recording difference<div class="fs-8 fw-normal">Fee ledger minus partner figures, at the schools that have partner transactions</div></td>
      <td class="text-end tnum"></td><td class="text-end tnum" title="₹${nf(LN.difference_rs, 2)}">${signed(LN.difference_rs, rs)}</td>
      <td class="text-end tnum">${signed(LN.difference_loans, nf)}</td><td></td></tr>` : '');
  $('#partnerRows').innerHTML = (partners.length || extraRows) ? partnerRows + extraRows
    + `<tr class="fw-bold sticky-total" id="loanTotalRow"><td>Total = fees paid by loan</td><td class="text-end tnum"></td><td class="text-end tnum" title="₹${nf(ledger, 2)}">${rs(ledger)}</td><td class="text-end tnum">${nf(LN.ledger_loans || 0)}</td><td></td></tr>`
    : '<tr><td colspan="5" class="text-muted-2 py-4">No loan payments and no loan partner for the schools in these filters.</td></tr>';
  $('#partnerNote').textContent = (partners.length || extraRows)
    ? `Partners ${rs(totalDisb)} + no partner recorded ${rs(LN.unassigned_rs || 0)} ${LN.difference_rs < 0 ? '−' : '+'} recording difference ${rs(Math.abs(LN.difference_rs || 0))} = ${rs(ledger)}, the same as the chart. Scroll the table to see every partner.`
    : '';
  // ---- Upsell matrix ----
  const short = (n) => n.replace(/ of Institutions| Autonomous/gi, '');
  const cell = (st, fit, play, bg) => {
    const list = inst.filter((x) => x.status === st && x.loanFit === fit).sort((a, b) => b.off - a.off);
    const names = list.slice(0, 6).map((x) => `<a href="#institute/${encodeURIComponent(x.id)}" data-inst-popup="${esc(x.id)}" class="text-reset">${esc(short(x.name))}</a>`).join(' · ');
    registerList(`${st}:${fit}`, `${play} (${nf(list.length)} schools)`, list);
    const more = list.length > 6 ? ` · <a href="#institutes" data-list-popup="${st}:${fit}" class="fw-semibold text-reset">+${nf(list.length - 6)} more</a>` : '';
    return `<div class="mcell" style="background:${bg}"><div class="d-flex justify-content-between align-items-baseline gap-2"><b class="fs-7">${play}</b><b class="fs-5 tnum">${nf(list.length)}</b></div><span class="fs-8">${list.length ? names + more : '<span class="text-faint">None in view</span>'}</span></div>`;
  };
  $('#matrix').innerHTML = `<span></span><b class="fs-7 text-blue px-1">High fees: ₹35,000+ per student (offer loan / EMI)</b><b class="fs-7 text-muted-2 px-1">Lower fees</b>
    <div class="d-flex align-items-center gap-2 fw-semibold"><i class="sw" style="background:${P.pg}"></i>10%+ paid online</div>${cell('live', true, 'Offer a loan / EMI partner', 'var(--mcb-blue-soft)')}${cell('live', false, 'Doing well: keep growing', 'var(--mcb-violet-soft)')}
    <div class="d-flex align-items-center gap-2 fw-semibold"><i class="sw" style="background:${P.neft}"></i>Under 10% paid online</div>${cell('low', true, 'Push pay links + offer loan / EMI', 'var(--mcb-amber-soft)')}${cell('low', false, 'Push pay links', 'var(--mcb-amber-soft)')}
    <div class="d-flex align-items-center gap-2 fw-semibold"><i class="sw" style="background:${P.cash}"></i>Nothing paid online</div>${cell('nopg', true, 'Sell gateway + loan / EMI together', 'var(--mcb-orange-soft)')}${cell('nopg', false, 'Sell the gateway', 'var(--mcb-orange-soft)')}
    <div class="d-flex align-items-center gap-2 fw-semibold"><i class="sw" style="background:${P.oth}"></i>No recent fees</div>${cell('dormant', true, 'Call first: fees stopped', 'var(--mcb-surface-2)')}${cell('dormant', false, 'Call first: fees stopped', 'var(--mcb-surface-2)')}`;
}
