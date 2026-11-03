/* VIEW 1 · COMMAND CENTER */
import { D, S, rates, INST, L, lastMon, prevMon, gfActive } from '../store.js';
import { esc, nf, cr, money, rs, pct, sum, lakh, growth, fullMonth, range, yearOf } from '../format.js';
import { roleChip, playChip } from '../metrics.js';
import { drawChart, pal, tipRow } from '../chart.js';
import { labeledBar } from '../segments.js';
import { registerList, openMonthPopup } from './instPopup.js';
import { api } from '../api.js';
import { T } from '../lang.js';
import { $, ic, chip, setBar, fill } from '../ui.js';

const CONVK = ['cash', 'card', 'cheque', 'dd'];
const SHORT = { cash: 'Cash', card: 'Card swipe', cheque: 'Cheque', dd: 'DD' };

/* "What is counted in the total": the server sums every line in SQL; fetched once per financial year and snapshot. */
const RECON = { key: '', data: null };
function renderTotalRecon() {
  const box = $('#totalReconRows');
  if (!box) return;
  const key = S.fy + '|' + (D.meta?.snapshot || '');
  const paint = () => {
    box.innerHTML = RECON.data.steps.map((s) => {
      const edge = s.key === 'raw' || s.key === 'portal';
      const amt = edge ? rs(s.amount_rs) : (s.amount_rs > 0 ? '+' : '−') + rs(Math.abs(s.amount_rs));
      return `<tr class="${edge ? 'fw-bold' : ''}" data-recon="${esc(s.key)}"${s.key === 'portal' ? ' style="background:var(--mcb-violet-soft)"' : ''}>
        <td>${esc(s.label)}</td><td class="text-end tnum ${edge ? '' : 'text-orange'}" title="₹${nf(s.amount_rs, 2)}">${amt}</td>
        <td class="text-end tnum">${edge ? nf(s.organisations) : (s.organisations ? '−' + nf(s.organisations) : '—')}</td>
        <td class="text-end tnum">${edge ? nf(s.rows) : (s.rows ? '−' + nf(s.rows) : '—')}</td>
        <td class="fs-8 text-muted-2 fw-normal">${esc(s.key === 'portal' ? 'The “Total fees collected” box above, when no filter is picked' : s.key === 'raw' ? 'SUM(PaidAmount) over the whole financial year' : s.note)}</td></tr>`;
    }).join('');
  };
  if (RECON.key === key && RECON.data) { paint(); return; }
  if (RECON.key === key) return;                       // already loading
  RECON.key = key; RECON.data = null;
  box.innerHTML = '<tr><td colspan="5" class="text-muted-2">Loading…</td></tr>';
  api.totalReconciliation(S.fy).then((d) => { if (RECON.key !== key) return; RECON.data = d; paint(); })
    .catch((err) => { if (RECON.key === key) { RECON.key = ''; box.innerHTML = `<tr><td colspan="5" class="text-danger">Could not load: ${esc(err.message)}</td></tr>`; } });
}

export function renderCommand() {
  renderTotalRecon();
  const r = rates(), P = pal();
  const M = D.modes, months = M.months, li = L(), pi = li - 1;
  const fy = S.period === 'fytd';
  const byKey = Object.fromEntries(M.modes.map((m) => [m.key, m.values]));
  const zero = months.map(() => 0);
  const mv = (k) => byKey[k] || zero;
  const at = (k, idx) => (idx === null ? sum(mv(k)) : mv(k)[idx] || 0);
  const convAt = (idx) => sum(CONVK.map((k) => at(k, idx)));
  const loanIdx = D.loans.summary.months.indexOf(lastMon());
  const prevLoanIdx = D.loans.summary.months.indexOf(prevMon());

  const total = fy ? (M.total_fytd ?? sum(M.month_totals)) : M.month_totals[li];   // the server's own total
  const pgV = fy ? D.gw.summary.fytd : D.gw.summary.monthly[li];
  const convV = convAt(fy ? null : li);
  const loanV = fy ? D.loans.summary.fytd : (D.loans.summary.amount[loanIdx] || 0);
  const share = total ? 100 * pgV / total : 0;
  // Commission accrues only on the share of gateway volume that runs on active MCB-partner gateways.
  const ps = D.comm && D.gw.summary.fytd ? Math.min(1, (D.comm.earning_volume_rs / 1e7) / D.gw.summary.fytd) : 1;
  const revenue = pgV * r.take * ps + loanV * r.loan;
  const g = (a, b) => growth(a, b) ?? 0;
  const signed = (v) => (v >= 0 ? '+' : '−') + pct(Math.abs(v));

  fill('.fyLbl', S.fy);
  $('#scopeLbl').innerHTML = gfActive().length
    ? `<b class="text-violet">Filtered view</b> · ${nf(D.inst.institutes.length)} institute${D.inst.institutes.length === 1 ? '' : 's'}`
    : 'All institutes';
  fill('.lastMonLbl', fullMonth(lastMon()));
  fill('.prevMonLbl', fullMonth(prevMon() || ''));
  $('#pLastLbl').textContent = fullMonth(lastMon());
  $('#periodLabel').textContent = fy ? fullMonth(months[0]) + ' to ' + fullMonth(lastMon()) : `${fullMonth(lastMon())} ${yearOf(lastMon(), S.fy)} vs ${fullMonth(prevMon())}`;

  // ---- Signal sentence ----
  const shareOf = (i) => M.month_totals[i] ? 100 * mv('pg')[i] / M.month_totals[i] : 0;
  const s0 = shareOf(0), sN = shareOf(li);
  const shareTxt = Math.abs(sN - s0) < 1
    ? `<b class="text-white">stuck at ${pct(sN)}</b> — where it was in ${fullMonth(months[0])} —`
    : sN > s0 ? `<b class="text-white">up to ${pct(sN)}</b> from ${pct(s0)} in ${fullMonth(months[0])},`
      : `<b class="text-white">down to ${pct(sN)}</b> from ${pct(s0)} in ${fullMonth(months[0])},`;
  const cashG = g(mv('cash')[li], mv('cash')[pi]);
  $('#signalText').innerHTML = li < 1
    ? `In ${fullMonth(lastMon())}, <b class="text-white">${pct(sN)}</b> of fees were paid online through MCB and <b style="color:#FFB088">${cr(mv('cash')[li] || 0, 0)} was paid in cash</b>. Every rupee of that cash could have been a pay link.`
    : `The share of fees paid online through MCB is ${shareTxt} while <b style="color:#FFB088">cash payments ${cashG >= 0 ? 'rose' : 'fell'} ${pct(Math.abs(cashG), 0)} in ${fullMonth(lastMon())}</b> to ${cr(mv('cash')[li], 0)}. Every rupee of that cash could have been a pay link.`;

  // ---- KPI tiles: the total and every part of it. The amounts come from the server (M.groups, M.total_fytd),
  //      which sums them in the database's own figures and fits the rounding so the parts add up to the total. ----
  const lm = M.last_month || {};
  const convBreak = (idx) => CONVK.map((k) => SHORT[k] + ' ' + cr(at(k, idx))).join(' · ');
  const vsPrev = ' compared with ' + fullMonth(prevMon() || '');
  const GR = M.groups || [];
  const gAmt = (x, idx) => (idx === null ? x.fytd : (x.values[idx] || 0));
  const gTxn = (x, idx) => (idx === null ? x.fytd_txns : (x.txns[idx] || 0));
  const pIdx = fy ? null : li;
  // sw colour, value class, help, "growing is good for MCB", analyst label
  const TILE = {
    pg: [P.pg, 'text-violet', 'Fees parents paid online through an MCB payment gateway', true, 'MCB PG volume'],
    neft: [P.neft, '', 'NEFT, direct UPI and BBPS paid straight to the school\'s bank: online, but not through MCB', false, 'NEFT / UPI / BBPS'],
    offline: [P.cash, 'text-orange', 'Cash, card swipe, cheque and DD paid at the school counter. MCB earns nothing on this until it moves to pay links.', false, 'Convertible offline'],
    ecs: [P.ecs, '', 'Automatic bank debits (ECS / NACH)', true, 'ECS / NACH'],
    loan: [P.ln, '', 'Fees paid through loan partners (the "Loan Payments" mode)', true, 'Loan Payments mode'],
    other: [P.oth, '', 'Payment methods without a group of their own', true, 'Other modes']
  };
  const tiles = [
    { sw: getComputedStyle(document.documentElement).getPropertyValue('--mcb-ink').trim(), label: 'Total fees collected', adv: 'Total collections (GMV)', value: cr(total, 2), kind: 'all',
      help: 'All fees schools collected, by every payment method. The six boxes after this one add up to it.',
      sub: fy ? `${range(months)} · every payment method` : [lm.txns ? lakh(lm.txns) + ' payments' : '', lm.paying_students ? lakh(lm.paying_students) + ' students paid' : ''].filter(Boolean).join(' · '),
      delta: fy ? '' : signed(g(M.month_totals[li], M.month_totals[pi])) + vsPrev, good: true }
  ].concat(GR.map((x) => {
    const t = TILE[x.key] || TILE.other, v = gAmt(x, pIdx), prev = pi >= 0 ? (x.values[pi] || 0) : 0;
    const what = x.key === 'offline' ? convBreak(pIdx) : x.key === 'other' ? (x.includes.join(', ') || 'none this period') : '';
    return { sw: t[0], cls: t[1], label: x.label, adv: t[4], value: cr(v, 2), kind: x.key, help: t[2] + (x.includes.length ? ' · In the database: ' + x.includes.join(', ') : ''),
      sub: `${pct(total ? 100 * v / total : 0)} of all fees · ${lakh(gTxn(x, pIdx))} payments`, sub2: what,
      delta: fy || !prev ? '' : signed(g(v, prev)) + vsPrev, good: t[3] ? v >= prev : v <= prev };
  })).concat([
    { sw: P.pg, label: 'MCB commission earned (estimate)', adv: 'Est. MCB revenue (take × partner PG + loan fee)', value: money(revenue), cls: 'text-violet',
      help: 'Commission rate × online fees through our partner gateways, plus the loan fee. Change the rate in the filter bar. Not part of the total.',
      sub: `${pct(r.take * 100, 2)} of ${cr(pgV * ps, 0)} paid through our partner gateways${r.loan ? ` + ${pct(r.loan * 100, 2)} loan fee` : ''}`, delta: '', good: true }
  ]);
  $('#kpis').innerHTML = tiles.map((t) => `
    <div class="col"><div class="card h-100" title="${esc(t.help || '')}"${t.kind ? ` data-months-popup="" data-kind="${esc(t.kind)}" role="button" tabindex="0" style="cursor:pointer"` : ''}><div class="card-body py-3">
      <div class="d-flex align-items-center gap-2"><i class="sw" style="background:${t.sw}"></i><span class="kpi-label">${T(esc(t.label), esc(t.adv || t.label))}</span></div>
      <div class="kpi-value mt-2 ${t.cls || ''}">${t.value}</div>
      <div class="kpi-sub mt-1">${esc(t.sub)}</div>
      ${t.sub2 ? `<div class="fs-8 text-muted-2 mt-1">${esc(t.sub2)}</div>` : ''}
      ${t.delta ? `<div class="fs-8 fw-bold mt-1 ${t.good ? 'text-violet' : 'text-orange'}">${esc(t.delta)}</div>` : ''}
      ${t.kind ? '<div class="fs-8 fw-semibold text-violet mt-1">Click to see every month</div>' : ''}
    </div></div></div>`).join('');
  // The sum, written out, so anyone can add the boxes up.
  const partsSum = Math.round(GR.reduce((a, x) => a + gAmt(x, pIdx), 0) * 1e9) / 1e9;
  $('#kpiSum').innerHTML = GR.length ? `<b>How the total adds up${fy ? '' : ' in ' + esc(fullMonth(lastMon()))}:</b> `
    + GR.map((x) => `${esc((TILE[x.key] || TILE.other)[4] === 'MCB PG volume' ? 'Online via MCB' : x.key === 'neft' ? 'Bank transfer' : x.key === 'offline' ? 'Offline' : x.key === 'ecs' ? 'Auto-debit' : x.key === 'loan' ? 'Loan' : 'Other')} ${cr(gAmt(x, pIdx), 2)}`).join(' + ')
    + ` = <b>${cr(partsSum, 2)}</b>` + (Math.abs(partsSum - total) < 5e-10 ? ' — matches total fees collected.' : ` — <span class="text-danger">differs from the total ${cr(total, 2)}</span>.`) : '';

  // ---- Mode mix chart (fixed stack order: PG, Internet, Cash, Cheque&DD, Card swipe, Other) ----
  const known = ['pg', 'neft', 'cash', 'cheque', 'dd', 'card', 'ecs', 'loan'];
  const series = [
    ['Online via MCB gateway', 'pg', mv('pg')],
    ['Bank transfer (not via MCB)', 'neft', mv('neft')],
    ['Cash', 'cash', mv('cash')],
    ['Cheque & DD', 'chq', months.map((_, i) => (mv('cheque')[i] || 0) + (mv('dd')[i] || 0))],
    ['Card swipe', 'card', mv('card')],
    ['Auto-debit (ECS)', 'ecs', mv('ecs')],
    ['Education loan', 'ln', mv('loan')],
    ['Other', 'oth', months.map((_, i) => Math.max(0, M.month_totals[i] - known.reduce((a, k) => a + (mv(k)[i] || 0), 0)))]
  ];
  $('#mixLegend').innerHTML = series.map((s) => `<span><i class="sw" style="background:${P[s[1]]}"></i>${s[0]}</span>`).join('');
  const shares = (arr) => arr.map((v, i) => M.month_totals[i] ? +(100 * v / M.month_totals[i]).toFixed(2) : 0);
  drawChart('mixChart', {
    onClick: (i) => openMonthPopup({ kind: 'all', month: months[i] }),
    height: 340, labels: months, yMax: 100, yStep: 25, yFmt: (v) => v + '%',
    segFmt: (v) => (v >= 5 ? Math.round(v) + '%' : ''),
    sub: months.map((_, i) => pct(shareOf(i)) + ' online'),
    subShort: months.map((_, i) => pct(shareOf(i), 0)),
    series: series.map((s) => ({ name: s[0], color: P[s[1]], values: shares(s[2]) })),
    aria: (i) => months[i] + ': MCB gateway ' + pct(shareOf(i)) + ' of ' + cr(M.month_totals[i], 0),
    tip: (i) => `<b>${months[i]} ${yearOf(months[i], S.fy)}</b>` + series.slice().reverse().map((s) => tipRow(P[s[1]], s[0], pct(100 * s[2][i] / M.month_totals[i]) + ' · ' + cr(s[2][i], 1))).join('') + `<div class="ft">Total ${cr(M.month_totals[i], 0)}</div>`
  });
  // Weakest gateway month note
  if (months.length > 1) {
    let lo = 0; months.forEach((_, i) => { if (shareOf(i) < shareOf(lo)) lo = i; });
    const cashShare = M.month_totals[lo] ? 100 * mv('cash')[lo] / M.month_totals[lo] : 0;
    $('#mixNote').hidden = false;
    $('#mixNote').textContent = `${fullMonth(months[lo])} had the lowest online share: only ${pct(shareOf(lo))} of fees came through the MCB gateway and ${pct(cashShare)} was cash. Send pay-link reminders before busy fee months, not after.`;
  } else $('#mixNote').hidden = true;

  // ---- Simulator: converted offline money earns commission only when it lands on an active partner gateway ----
  const extra = convV * S.shift / 100;
  const shareNew = total ? 100 * (pgV + extra) / total : 0;
  const extraRev = extra * r.take * ps;
  $('#shift').value = S.shift;
  $('#shiftOut').textContent = S.shift + '%';
  $('#shareNow').textContent = pct(share);
  $('#shareNew').textContent = pct(shareNew);
  setBar('#shareNowPb', share); setBar('#shareNewPb', shareNew);
  $('#extraGmv').textContent = cr(extra, 0);
  $('#extraRev').textContent = money(extraRev);
  $('#basis1').textContent = $('#basis2').textContent = fy ? range(months) + ' basis' : fullMonth(lastMon()) + ' basis';
  $('#extraAnnual').textContent = money(fy ? extraRev * 12 / months.length : extraRev * 12);
  fill('.takeLbl', pct(r.take * 100, 2));

  // ---- Partition table ----
  const fyTot = sum(M.month_totals);
  $('#modeRows').innerHTML = M.modes.map((m) => {
    const f = sum(m.values), last = m.values[li] || 0, prev = m.values[pi] || 0;
    const mom = growth(last, prev);
    const up = (mom ?? 0) >= 0;
    let col = 'text-muted-2';
    if (m.role === 'Earns') col = up ? 'text-violet' : 'text-orange';
    if (m.role === 'Convertible' || m.role === 'Outside MCB PG') col = up ? 'text-orange' : 'text-violet';
    const s = fyTot ? f / fyTot : 0;
    const barCol = { Earns: P.pg, Convertible: P.cash, 'Outside MCB PG': P.neft, Mandate: P.chq, Other: P.oth }[m.role];
    return `<tr>
      <td class="fw-semibold">${esc(m.name)}</td>
      <td>${roleChip(m.role)}</td>
      <td class="text-end tnum">${cr(f, 1)}</td>
      <td><div class="d-flex align-items-center gap-2"><div class="progress flex-grow-1" role="progressbar" aria-label="${esc(m.name)} share" aria-valuenow="${(s * 100).toFixed(1)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${Math.max(0.5, 100 * s).toFixed(1)}%;background:${barCol}"></div></div><span class="tnum text-end" style="width:44px">${pct(s * 100)}</span></div></td>
      <td class="text-end tnum">${cr(last, last < 1 ? 2 : 1)}</td>
      <td class="text-end tnum fw-semibold ${mom === null ? 'text-faint' : col}">${mom === null ? '—' : `${ic(up ? 'caret-up-fill' : 'caret-down-fill')} ${pct(Math.abs(mom))}<span class="visually-hidden">${up ? ' up' : ' down'}</span>`}</td>
      <td class="text-muted-2">${esc(m.play)}</td></tr>`;
  }).join('');

  // ---- Coverage ----
  const inst = INST();
  const cnt = (s) => inst.filter((x) => x.status === s).length;
  const cov = [['live', '10% or more paid online', P.pg, ''], ['low', 'Under 10% paid online', P.neft, ''], ['nopg', 'Nothing paid online: sell the gateway', P.cash, 'warn'], ['dormant', `No fees in ${range(D.inst.months.slice(-2))}`, P.oth, '']];
  $('#covCount').textContent = inst.length;
  const COV_SHORT = { live: '10%+ online', low: 'Under 10%', nopg: 'Nothing online', dormant: 'No recent fees' };
  $('#covBar').innerHTML = labeledBar(cov.map((c) => ({
    label: COV_SHORT[c[0]], value: cnt(c[0]), color: c[2], list: 'st:' + c[0],
    text: `${COV_SHORT[c[0]]}: ${nf(cnt(c[0]))}`, keyText: `${nf(cnt(c[0]))} schools (${pct(inst.length ? 100 * cnt(c[0]) / inst.length : 0, 0)})`
  })));
  cov.forEach((c) => registerList('st:' + c[0], esc(c[1]), inst.filter((x) => x.status === c[0]).sort((a, b) => b.tot - a.tot), 'biggest fees first'));
  $('#covTiles').innerHTML = cov.map((c) => `<div class="col-6"><a class="tile-link ${c[3]}" href="#command" data-list-popup="st:${c[0]}"><span class="fs-7 text-muted-2 d-flex align-items-center gap-2"><i class="sw" style="background:${c[2]}"></i>${esc(c[1])}</span><b class="fs-5">${cnt(c[0])}</b></a></div>`).join('');

  const partners = D.loans.partners.slice().sort((a, b) => b.institutes - a.institutes);
  if (!partners.length) {
    const fit = inst.filter((x) => x.loanFit);
    $('#loanCovSub').textContent = 'partner details not connected yet';
    $('#loanCov').innerHTML = `<div class="fs-7 text-muted-2">${cr(D.loans.summary.fytd)} of fees were paid through education loans in ${range(D.loans.summary.months)} (${nf(D.loans.summary.fytd_txns)} payments).</div>`;
    $('#loanCovNote').textContent = `${nf(fit.length)} schools have high fees (₹35,000 or more per student, ${range(D.inst.months)}), so a loan / EMI offer makes sense. ${rs(sum(fit.map((x) => x.off)))} of their fees were paid offline (cash, card, cheque, DD).`;
    return renderOppsAndRest(inst, P);
  }
  const top = partners.slice(0, 5), rest = partners.slice(5);
  const lc = top.map((p) => [p.name, p.institutes]).concat(rest.length ? [[rest.length + ' others', sum(rest.map((p) => p.institutes))]] : []);
  const lcMax = Math.max(1, ...lc.map((l) => l[1]));
  const mappings = sum(partners.map((p) => p.institutes));
  $('#loanCovSub').textContent = `${partners.length} partners · ${mappings} institute mappings`;
  $('#loanCov').innerHTML = lc.map((l) => `<div class="d-grid align-items-center gap-2 fs-7" style="grid-template-columns:120px minmax(0,1fr) 28px"><span>${esc(l[0])}</span><div class="progress" role="progressbar" aria-label="${esc(l[0])} institutes" aria-valuenow="${l[1]}" aria-valuemin="0" aria-valuemax="${lcMax}"><div class="progress-bar" style="width:${(100 * l[1] / lcMax).toFixed(1)}%;background:${P.loan}"></div></div><span class="text-end tnum">${l[1]}</span></div>`).join('');
  const idle = partners.filter((p) => !p.loans).length;
  $('#loanCovNote').textContent = `${idle} of ${partners.length} partners had no loan payment in ${range(D.loans.summary.months)}. ${inst.filter((x) => x.loanFit).length} institutes in view are loan-fit (collections ≥ ₹35,000 per student, ${range(D.inst.months)}).`;
  renderOppsAndRest(inst, P);
}

function renderOppsAndRest(inst, P) {
  // ---- Top opportunities ----
  $('#topOpps').innerHTML = inst.slice().sort((a, b) => b.score - a.score).slice(0, 5).map((o, i) => `
    <a class="opp-row" href="#institute/${encodeURIComponent(o.id)}" data-inst-popup="${esc(o.id)}" title="Show this school's details">
      <span class="rank">${i + 1}</span>
      <span class="d-flex flex-column gap-1" style="min-width:0"><span class="fw-semibold text-truncate">${esc(o.name)}</span>
        <span class="d-flex flex-wrap align-items-center gap-2 fs-8 text-muted-2">${playChip(o.play)}${nf(o.students)} students paid · ${pct(o.share * 100)} paid online</span></span>
      <span class="d-flex flex-column align-items-end gap-1"><b class="text-orange tnum">${rs(o.off)}</b><span class="fs-8 text-muted-2">paid offline, ${range(D.inst.months)} · opportunity ${o.score}/100</span></span>
    </a>`).join('') || '<div class="text-muted-2 py-3">No institutes in the extract yet.</div>';

  // ---- Gateway mini list ----
  const gws = D.gw.gateways.slice().sort((a, b) => b.volume - a.volume);
  const top7 = gws.slice(0, 7);
  const other = D.gw.summary.fytd - sum(top7.map((x) => x.volume));
  const rows = top7.map((x) => [x.name, x.volume, x.note.startsWith('Identical')]).concat(other > 5e-10 ? [['Other gateways', other, false]] : []);
  const max = Math.max(1e-9, ...rows.map((x) => x[1]));
  $('#gwMiniSub').textContent = `Online fees by gateway: ${cr(D.gw.summary.fytd)} in ${lakh(D.gw.summary.fytd_txns)} payments, ${range(D.gw.summary.months)}. The % is each gateway's share.`;
  $('#gwMini').innerHTML = rows.map((x) => `<div class="bar-row"><span class="d-flex align-items-center gap-1">${esc(x[0])}${x[2] ? ' <span class="chip chip-red" style="padding:1px 6px" title="Identical to another gateway">check</span>' : ''}</span>
    <div class="progress" style="height:10px" role="progressbar" aria-label="${esc(x[0])} volume" aria-valuenow="${x[1]}" aria-valuemin="0" aria-valuemax="${max}"><div class="progress-bar" style="width:${Math.max(0.5, 100 * x[1] / (D.gw.summary.fytd || 1)).toFixed(1)}%;background:${x[0] === 'Other gateways' ? P.neft : P.pg}"></div></div>
    <span class="text-end tnum">${cr(x[1], 1)}</span><span class="text-end text-muted-2 tnum">${pct(100 * x[1] / D.gw.summary.fytd)}</span></div>`).join('');

  // ---- Needs attention ----
  const AL = {
    danger: ['var(--mcb-red-soft)', 'exclamation-triangle', 'text-danger'],
    warning: ['var(--mcb-orange-soft)', 'graph-up-arrow', 'text-orange'],
    growth: ['var(--mcb-violet-soft)', 'graph-up-arrow', 'text-violet'],
    info: ['var(--mcb-surface-2)', 'clock-history', '']
  };
  $('#alerts').innerHTML = D.alerts.map((a) => {
    const t = AL[a.severity] || AL.info;
    const icon = a.title.startsWith('Refresh') ? 'arrow-repeat' : t[1];
    const title = a.institute_id ? `<a href="#institute/${encodeURIComponent(a.institute_id)}"><b>${esc(a.title)}</b></a>` : `<b>${esc(a.title)}</b>`;
    return `<div class="alert-item" style="background:${t[0]}">${ic(icon, t[2])}<span>${title} ${esc(a.text)}</span></div>`;
  }).join('') || '<div class="text-muted-2 fs-7">Nothing needs attention right now.</div>';
}
