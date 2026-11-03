/* VIEW 3 · INSTITUTE 360 (#institute/<DBName:OrganisationID>) */
import { D, S, rates, instById } from '../store.js';
import { api } from '../api.js';
import { esc, nf, rs, crAxis, pct, range, yearOf, growth, fmtDate, fmtDay } from '../format.js';
import { T } from '../lang.js';
import { STATUS, LOAN_FIT_RS, locked, roleChip, metrics } from '../metrics.js';
import { drawChart, pal, tipRow, inkOn } from '../chart.js';
import { $, $$, chip, fill, toastError } from '../ui.js';
import { SEG, SEG_HELP, MODE_GROUPS, mixLegend, COV, branchCell, branchesOn, segName, modeColorKey } from '../segments.js';
import { openMonthPopup, accountGrid } from './instPopup.js';


/** What a payment mode covers, for the two online modes people mix up: [short line under the name, full tooltip]. */
const MODE_INCLUDES = {
  pg: ['UPI, cards, net banking & wallets via MCB gateway',
    'Paid by parents through the MCB payment gateway (pay link, parent app or school website): UPI, debit / credit card, net banking and wallets. MCB earns commission on this.'],
  neft: ['NEFT / RTGS / IMPS bank transfer, outside MCB',
    'Paid by bank transfer (NEFT, RTGS or IMPS) straight into the school\'s bank account and recorded by the school. It does not go through the MCB gateway, so MCB earns nothing on it.']
};
const includesLine = (key) => MODE_INCLUDES[key]
  ? `<span class="fs-8 text-muted-2 lh-sm mt-1" title="${esc(MODE_INCLUDES[key][1])}">${esc(MODE_INCLUDES[key][0])}</span>` : '';

/** Payment-type analysis: one horizontal bar per payment mode, then a grid of monthly bar charts (one card per mode). */
function renderTypeGrids(months, modes) {
  const P = pal();
  const rows = modes.map((m) => {
    const total = m.values.reduce((a, b) => a + b, 0), n = m.txns.reduce((a, b) => a + b, 0);
    return { m, total, n, color: P[modeColorKey(m.key)] };
  }).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  const all = rows.reduce((a, r) => a + r.total, 0);
  if (!rows.length) {
    $('#i360TypeBars').innerHTML = '<div class="text-muted-2 fs-7">No fees recorded for this school in the selected months.</div>';
    $('#i360TypeGrid').innerHTML = ''; $('#i360TypeLegend').innerHTML = '';
    return;
  }
  $('#i360TypeLegend').innerHTML = mixLegend();
  const share = (v) => (all ? 100 * v / all : 0);

  // 1) Bar chart comparing payment types (bar length = share of all fees).
  $('#i360TypeBars').innerHTML = rows.map((r) => {
    const s = share(r.total), ink = inkOn(r.color);
    const inside = s >= 30 ? rs(r.total) : '';
    return `<div class="hbar-row">
      <span class="d-flex flex-column"><b class="text-truncate" title="${esc(r.m.name)}">${esc(r.m.name)}</b>${roleChip(r.m.role)}${includesLine(r.m.key)}</span>
      <div class="hbar-track" title="${esc(r.m.name)}: ${rs(r.total)} · ${pct(s)} of fees · ${nf(r.n)} payments"><div class="hbar-fill" style="width:${Math.max(0.8, s).toFixed(1)}%;background:${r.color};color:${ink}">${esc(inside)}</div></div>
      <span class="text-end tnum fw-semibold">${rs(r.total)}<div class="fs-8 text-muted-2 fw-normal">${T(`${nf(r.n)} payments`, `${nf(r.n)} txns · ${rs(r.n ? r.total / r.n : 0)} avg`)}</div></span>
      <span class="text-end tnum">${pct(s)}</span></div>`;
  }).join('');

  // 2) Grid: one small monthly bar chart per payment type.
  const li = months.length - 1;
  $('#i360TypeGrid').innerHTML = rows.map((r) => {
    const vals = r.m.values, max = Math.max(...vals, 1);
    const peak = vals.indexOf(Math.max(...vals));
    const mom = li > 0 ? growth(vals[li], vals[li - 1]) : null;
    const cols = vals.map((v, i) => `<div class="pm-col${i === peak && v > 0 ? ' peak' : ''}" title="${esc(months[i])}: ${rs(v)} · ${nf(r.m.txns[i])} payments">
        <div class="b" style="height:${v ? Math.max(3, 100 * v / max).toFixed(1) : 0}%;background:${r.color};${i === peak ? 'outline:2px solid var(--mcb-violet);outline-offset:1px' : ''}"></div></div>`).join('');
    const trend = mom === null ? '' : mom >= 0 ? `<span class="text-violet">up ${pct(mom, 0)}</span>` : `<span class="text-orange">down ${pct(-mom, 0)}</span>`;
    const simple = `Most in <b>${esc(months[peak])}</b> (${rs(vals[peak])}).${trend ? ` ${esc(months[li])} was ${trend} on ${esc(months[li - 1])}.` : ''}`;
    const adv = `Peak ${esc(months[peak])} · ${nf(r.n)} txns · avg ticket ${rs(r.n ? r.total / r.n : 0)} · MoM ${mom === null ? '—' : (mom >= 0 ? '+' : '−') + pct(Math.abs(mom))} · ${pct(share(r.total))} of GMV`;
    return `<div class="col"><div class="pm-card">
      <div class="d-flex justify-content-between align-items-start gap-2">
        <div class="d-flex flex-column gap-1" style="min-width:0"><b class="text-truncate"><i class="sw me-1" style="background:${r.color}"></i>${esc(r.m.name)}</b>${roleChip(r.m.role)}${includesLine(r.m.key)}</div>
        <div class="text-end"><div class="fw-bold tnum">${rs(r.total)}</div><div class="fs-8 text-muted-2">${pct(share(r.total))} ${T('of all fees', 'of GMV')}</div></div>
      </div>
      <div class="pm-cols" role="img" aria-label="${esc(r.m.name)} by month: ${esc(vals.map((v, i) => months[i] + ' ' + rs(v)).join(', '))}">${cols}</div>
      <div class="pm-months">${months.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      <div class="fs-8 text-muted-2">${T(simple, adv)}</div>
    </div></div>`;
  }).join('');
}

/** The school's owner: its pipeline deal owner(s), else the account owner from the Assign menu, else NA. */
function ownerTag(x) {
  const deal = [...new Set(((D.pipe && D.pipe.deals) || []).filter((d) => d.institute_id === x.id && d.owner).reverse().map((d) => d.owner))];
  const acct = x.owner ? ((D.meta.owners || []).find((o) => o.id === x.owner) || { name: x.owner }).name : '';
  const name = deal.length ? deal.join(', ') : acct;
  return name ? `<b class="text-body" title="Assigned owner">${esc(name)}</b>` : '<span class="text-faint" title="No owner assigned yet">NA</span>';
}

/** Payment modes × months for one school: stacked chart by mode group + full table of every mode. */
function renderModeCard(x, extras) {
  const P = pal();
  if (!extras) {
    $('#i360TypeBars').innerHTML = '<div class="fs-8 text-faint py-3">Loading payment types…</div>';
    $('#i360TypeGrid').innerHTML = '';
    $('#i360ModeChart').innerHTML = '<div class="fs-8 text-faint py-4 text-center">Loading payment modes…</div>';
    $('#i360ModeHead').innerHTML = ''; $('#i360ModeRows').innerHTML = '';
    return;
  }
  const months = extras.months, modes = extras.modes;
  renderTypeGrids(months, modes);
  $('#i360ModeLegend').innerHTML = mixLegend();
  const grp = MODE_GROUPS.map((g) => ({
    name: g[1], color: P[g[2]],
    values: months.map((_, i) => modes.filter((m) => g[3] ? g[3].includes(m.key) : !MODE_GROUPS.some((h) => h[3] && h[3].includes(m.key)))
      .reduce((a, m) => a + m.values[i], 0) / 1e7)
  })).filter((s) => s.values.some((v) => v > 0));
  const monthTot = months.map((_, i) => modes.reduce((a, m) => a + m.values[i], 0));
  const monthTx = months.map((_, i) => modes.reduce((a, m) => a + m.txns[i], 0));
  drawChart('i360ModeChart', {
    onClick: (i) => openMonthPopup({ kind: 'all', month: months[i], inst: x.id }),
    height: 320, labels: months, yFmt: crAxis, series: grp,
    capAll: true, capFmt: (v) => rs(v * 1e7),
    segFmt: (v, s, i, t) => (t && v / t >= 0.12 ? Math.round(100 * v / t) + '%' : ''),
    aria: (i) => months[i] + ': ' + rs(monthTot[i]),
    tip: (i) => `<b>${months[i]} ${yearOf(months[i], S.fy)}</b>` + grp.slice().reverse().filter((s) => s.values[i] > 0)
      .map((s) => tipRow(s.color, s.name, rs(s.values[i] * 1e7) + ' · ' + pct(monthTot[i] ? 100 * s.values[i] * 1e7 / monthTot[i] : 0, 0))).join('')
      + `<div class="ft">Total ${rs(monthTot[i])} · ${nf(monthTx[i])} transactions</div>`
  });
  const fyTot = monthTot.reduce((a, b) => a + b, 0);
  $('#i360ModeSub').textContent = `${modes.length} payment mode${modes.length === 1 ? '' : 's'} · ${rs(fyTot)} across ${nf(monthTx.reduce((a, b) => a + b, 0))} transactions, ${range(months)}`;
  $('#i360ModeHead').innerHTML = `<tr><th scope="col">Payment mode</th>${months.map((m) => `<th scope="col" class="text-end">${m}</th>`).join('')}<th scope="col" class="text-end">Total this year</th><th scope="col" class="text-end" title="This mode's share of the school's fees">% of fees</th><th scope="col" class="text-end">No. of payments</th></tr>`;
  const row = (m) => {
    const t = m.values.reduce((a, b) => a + b, 0), n = m.txns.reduce((a, b) => a + b, 0);
    return `<tr><td class="fw-semibold">${esc(m.name)} <span class="ms-1">${roleChip(m.role)}</span></td>
      ${m.values.map((v, i) => `<td class="text-end tnum" title="${nf(m.txns[i])} transactions">${v ? rs(v) : '<span class="text-faint">—</span>'}</td>`).join('')}
      <td class="text-end tnum fw-semibold">${rs(t)}</td><td class="text-end tnum">${pct(fyTot ? 100 * t / fyTot : 0)}</td><td class="text-end tnum">${nf(n)}</td></tr>`;
  };
  $('#i360ModeRows').innerHTML = modes.slice().sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0)).map(row).join('')
    + `<tr class="fw-bold"><td>Total</td>${monthTot.map((v) => `<td class="text-end tnum">${rs(v)}</td>`).join('')}<td class="text-end tnum">${rs(fyTot)}</td><td class="text-end">100%</td><td class="text-end tnum">${nf(monthTx.reduce((a, b) => a + b, 0))}</td></tr>`
    + `<tr class="text-muted-2"><td>Students who paid</td>${extras.students.map((v) => `<td class="text-end tnum">${nf(v)}</td>`).join('')}<td colspan="3" class="fs-8">a student paying by two methods is counted twice</td></tr>`;
}

const detailCache = {};   // id -> { branches, notes }

export async function loadInstituteExtras(id, force) {
  if (!force && detailCache[id]) return detailCache[id];
  const [detail, notes] = await Promise.all([api.institute(id, { fy: S.fy, from: S.gf.from, to: S.gf.to, modes: S.gf.modes }).catch(() => null), api.notes(id).catch(() => [])]);
  detailCache[id] = {
    institute: detail ? detail.institute : null,
    branches: detail ? detail.branch_list : [], notes,
    months: detail ? detail.months : [], modes: detail ? detail.modes : [], students: detail ? detail.students : [],
    partner: detail ? detail.gateway_partner : {}
  };
  return detailCache[id];
}
export const dropInstituteExtras = (id) => { delete detailCache[id]; };
/** Filters changed (e.g. month range): every cached school detail is stale. */
export const clearInstituteExtras = () => { Object.keys(detailCache).forEach((k) => delete detailCache[k]); };

export function renderInstitute(id) {
  const sec = document.querySelector('[data-view="institute"]');
  // The global filters may exclude this school from the list; its page still shows it (month range applies).
  let x = instById(id);
  if (!x) {
    const ex = detailCache[id];
    if (!ex) {
      $('#i360Name').textContent = 'Loading…';
      loadInstituteExtras(id).then(() => { if (!sec.hidden) renderInstitute(id); }).catch(toastError);
      return;
    }
    if (ex.institute) x = Object.assign({}, ex.institute, metrics(ex.institute, rates(), ex.institute.months.length));
  }
  if (!x) {
    $('#i360Name').textContent = 'Institute not found';
    $('#i360Crumb').textContent = id || '';
    $('#i360Meta').innerHTML = `<span>No collections for this institute in FY ${esc(S.fy)}.</span>`;
    ['#i360Kpis', '#i360Setup', '#i360Nba', '#i360Timeline', '#i360Chart'].forEach((s) => { $(s).innerHTML = ''; });
    $('#i360Score').textContent = '—';
    return;
  }
  sec.dataset.inst = x.id;
  S.instId = x.id;
  const r = rates(), P = pal(), st = STATUS[x.status];
  const months = D.inst.months, win = range(months);
  const extras = detailCache[x.id];
  document.title = x.name + ' · MCB Revenue Intelligence';
  $('#i360Crumb').textContent = x.name;
  $('#i360Name').textContent = x.name;
  $('#i360Score').textContent = x.score;
  const statusLabel = st[0];
  const seg = SEG[x.partner_status];
  $('#i360Meta').innerHTML = `<span>${x.branches ? x.branches + (x.branches === 1 ? ' branch' : ' branches') : 'No branch information'} · up to ${nf(x.students)} students paid in a month</span>${seg ? `<span class="chip chip-${seg.tone}" title="${esc(SEG_HELP[x.partner_status])}">${segName(x.partner_status)}</span>` : ''}${chip(statusLabel, st[1], 'Share of fees paid online through the MCB gateway')}${x.loanFit ? chip('High fees: offer loan / EMI', 'blue') : ''}<span class="d-flex align-items-center gap-1">Owner ${ownerTag(x)}</span>`;
  $('#i360Score').parentElement.title = 'Opportunity score 0–100: higher means a bigger chance to grow online payments here';
  $('#i360Account').innerHTML = accountGrid(x);
  renderModeCard(x, extras);

  const lastTot = x.lastTot, lastM = months[months.length - 1] || '';
  $('#i360Kpis').innerHTML = [
    ['Fees collected, ' + win, rs(x.tot), `${rs(lastTot)} in ${lastM}`, '', true],
    ['Paid online through MCB', pct(x.share * 100), `of all fees · ${pct(x.lastShare * 100)} in ${lastM}`, 'text-violet', true],
    ['Paid offline (cash, card, cheque, DD)', rs(x.off), `${rs(x.lastOff)} in ${lastM}`, 'text-orange', true],
    ['Fees per student', rs(x.perStu), win + ' · ' + (x.loanFit ? 'high enough' : 'too low') + ` for a loan / EMI offer (line: ${rs(LOAN_FIT_RS)})`, '']
  ].map((k) => `<div class="col"><div class="card h-100"${k[4] ? ` data-months-popup="${esc(x.id)}" role="button" tabindex="0" style="cursor:pointer" title="Click to see every month"` : ''}><div class="card-body py-3"><div class="kpi-label">${esc(k[0])}</div><div class="kpi-value mt-1 ${k[3]}">${k[1]}</div><div class="kpi-sub mt-1">${esc(k[2])}</div>${k[4] ? '<div class="fs-8 fw-semibold text-violet mt-1">Click to see every month</div>' : ''}</div></div></div>`).join('');

  $$('[data-sw]').forEach((e) => { e.style.background = P[e.dataset.sw]; });
  const peak = x.months.reduce((best, mm, i, arr) => (mm[0] + mm[1] > arr[best][0] + arr[best][1] ? i : best), 0);
  drawChart('i360Chart', {
    onClick: (i) => openMonthPopup({ kind: 'all', month: months[i], inst: x.id }),
    height: 290, labels: months, yFmt: crAxis,
    series: [{ name: 'Paid online via MCB', color: P.pg, values: x.months.map((mm) => mm[0] / 1e7) }, { name: 'Paid any other way', color: P.cash, values: x.months.map((mm) => mm[1] / 1e7) }],
    capAll: true, capFmt: (v) => rs(v * 1e7),
    segFmt: (v, s, i, t) => (t && v / t >= 0.1 ? Math.round(100 * v / t) + '%' : ''),
    aria: (i) => months[i] + ': gateway ' + rs(x.months[i][0]) + ', offline ' + rs(x.months[i][1]),
    tip: (i) => `<b>${months[i]} ${yearOf(months[i], S.fy)}</b>` + tipRow(P.cash, 'Paid any other way', rs(x.months[i][1])) + tipRow(P.pg, 'Paid online via MCB', rs(x.months[i][0])) + `<div class="ft">Total ${rs(x.months[i][0] + x.months[i][1])}</div>`
  });

  // ---- Setup & coverage ----
  const gs = x.gateway_status;
  const gwChip = gs === 'unknown' ? chip('Details not available', 'gray')
    : gs === 'na' ? chip('No MCB gateway', 'orange')
      : gs === 'unmapped' ? chip('No gateway information', 'orange')
        : chip(x.status === 'live' ? 'Set up · in use' : x.status === 'low' ? 'Set up · rarely used' : 'Set up · not used', x.status === 'live' ? 'green' : x.status === 'low' ? 'amber' : 'orange');
  const naNote = x.na_branches ? ` ${x.na_branches} of ${x.branches} branches don't have an MCB gateway yet.` : '';
  const gwText = gs === 'unknown' ? 'Gateway details for this school could not be read.'
    : gs === 'na' ? 'This school does not use any MCB payment gateway. Pitch the MCB gateway with pay links and a UPI QR at the fee counter.'
      : gs === 'unmapped' ? 'We have no gateway information for this school.'
        : x.gateways.map((g) => {
          const p = extras ? extras.partner[g] : undefined;
          return `<span class="me-2">${esc(g)} ${p === true ? chip('Our partner (we earn)', 'violet') : p === false ? chip('Not our partner (no commission)', 'blue') : ''}</span>`;
        }).join('') + (x.status === 'nopg' ? ' · set up, but no fees were paid through it in ' + win + '.' : '') + naNote;
  const branchList = extras ? extras.branches : null;
  // N/A branches first: they are the ones to onboard.
  const ORDER = { na: 0, none: 1, non_partner: 2, partner: 3 };
  const branchText = (b) => b.status === 'na' ? 'No MCB gateway'
    : b.status === 'none' ? 'No gateway information' : esc(b.gateways.join(', ')) + (b.status === 'partner' ? ' · our partner' : ' · not our partner');
  const branchHtml = branchList === null ? '<span class="fs-8 text-faint">Loading branches…</span>'
    : branchList.length ? `${branchCell(x)}<ul class="list-unstyled m-0 mt-1 fs-7 d-flex flex-column gap-1" style="max-height:200px;overflow:auto">${branchList.slice().sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name)).map((b) => `<li class="d-flex justify-content-between gap-2"><span class="text-truncate">${esc(b.name)}</span><span class="text-nowrap ${b.status === 'partner' ? 'text-violet' : b.status === 'non_partner' ? 'text-blue' : 'text-orange fw-semibold'}">${branchText(b)}</span></li>`).join('')}</ul>`
      : '<span class="fs-8 text-faint">No branches in the gateway mapping.</span>';
  const label = { y: 'Granted', p: 'Pending', n: 'Not asked' };
  const next = { n: 'p', p: 'y', y: 'n' };
  const cTile = (k, name) => {
    const v = x.consent[k];
    return `<div class="col-4"><button type="button" class="consent-tile ${v} w-100 text-start" data-consent="${esc(x.id)}|${k}|${next[v]}" title="Click to change">
      <div class="text-muted-2">${name}</div><b class="${v === 'y' ? 'text-green' : v === 'p' ? '' : 'text-faint'}" style="${v === 'p' ? 'color:var(--mcb-amber-ink)' : ''}">${label[v]}</b></button></div>`;
  };
  const needConsent = Object.values(x.consent).some((v) => v === 'n');
  $('#i360Setup').innerHTML = `
    <h2 class="card-title">Setup &amp; coverage</h2>
    <div class="d-flex flex-column gap-1 pb-3 border-bottom"><div class="d-flex justify-content-between align-items-center gap-2"><b>Payment gateway</b>${gwChip}</div><span class="fs-7 text-muted-2">${gwText}</span></div>
    <div class="d-flex flex-column gap-2 pb-3 border-bottom"><div class="d-flex justify-content-between align-items-center gap-2"><b>Branches</b>${x.branch_coverage && COV[x.branch_coverage] ? chip(COV[x.branch_coverage].short, COV[x.branch_coverage].tone) : ''}</div>${branchHtml}</div>
    <div class="d-flex flex-column gap-2 pb-3 border-bottom"><b>Reminder consent from institute</b><div class="row g-2">${cTile('sms', 'SMS')}${cTile('wa', 'WhatsApp')}${cTile('app', 'App push')}</div>
      <div class="d-flex justify-content-between align-items-center gap-2"><span class="fs-8 text-faint">Click a channel to record its state.</span>${needConsent ? `<button type="button" class="btn btn-sm btn-quiet" data-request="${esc(x.id)}">Mark consent requested</button>` : ''}</div></div>
    <div class="d-flex flex-column gap-1"><div class="d-flex justify-content-between align-items-center gap-2"><b>Loan / EMI offer</b>${x.loanFit ? chip('Good fit', 'blue') : chip('Fees too low', 'gray')}</div>
      <span class="fs-7 text-muted-2">${x.loanFit ? `${rs(x.perStu)} per paying student in ${win} — high enough for an education-loan or EMI partner.` : 'Fees per paying student are below the loan-fit line; offer zero-cost EMI on pay links instead.'}</span></div>`;

  // ---- Next best actions ----
  const A = [];
  const remind = { tone: ['var(--mcb-violet-soft)', 'var(--mcb-violet-ink)'], t: 'Send pay links before the next due date', d: `${rs(x.lastOff)} came in offline in ${lastM}. Target parents who paid by cash, card swipe or cheque last term; stop reminding the moment they pay.`, imp: `30% shift ≈ ${rs(x.lastOff * 0.3)} a month through the gateway`, btn: `<button class="btn btn-primary text-nowrap" data-camp-inst="${esc(x.id)}">Build campaign</button>` };
  const sell = { tone: ['var(--mcb-orange-soft)', 'var(--mcb-orange-ink)'], t: 'Sell the MCB payment gateway', d: `All ${rs(x.other)} in ${win} was collected outside the MCB gateway, ${rs(x.off)} of it offline (cash, card, cheque, DD). Lead with pay links before due dates and a UPI QR at the fee counter.`, imp: `30% shift ≈ ${rs(x.off * x.annualise * 0.3)} a year through the gateway`, btn: `<button class="btn btn-primary text-nowrap" data-add-deal="${esc(x.id)}|Activate PG">Add to pipeline</button>` };
  const loan = { tone: ['var(--mcb-blue-soft)', 'var(--mcb-blue-ink)'], t: 'Pitch an education-loan or EMI partner', d: `${rs(x.perStu)} collected per paying student in ${months.length} months — fees that families often split. Earns the loan processing fee and moves instalments online.`, imp: 'Loan fee + gateway volume', btn: `<button class="btn btn-quiet text-nowrap" data-add-deal="${esc(x.id)}|Add loan partner">Add to pipeline</button>` };
  const qr = { tone: ['var(--mcb-orange-soft)', 'var(--mcb-orange-ink)'], t: 'Put an MCB UPI QR at the fee counter', d: 'Walk-in parents who would swipe a card or hand over cash pay through the gateway instead; the receipt lands in the ledger automatically.', imp: 'Captures counter cash and card swipes', btn: `<button class="btn btn-quiet text-nowrap" data-add-deal="${esc(x.id)}|Drive adoption">Add to pipeline</button>` };
  const reeng = { tone: ['var(--mcb-gray-soft)', 'var(--mcb-gray-ink)'], t: 'Re-engage the institute', d: `No collections are recorded for the last two months of ${win}. Check whether fee collection moved off MCB or the data sync stopped.`, imp: 'Protects existing volume', btn: `<button class="btn btn-primary text-nowrap" data-add-deal="${esc(x.id)}|Re-engage">Add to pipeline</button>` };
  const consent = { tone: ['var(--mcb-violet-soft)', 'var(--mcb-violet-ink)'], t: 'Get reminder consent', d: 'Reminders can only go out on channels the institute has approved. Send the consent form to the principal or finance head.', imp: 'Unlocks pay-link campaigns', btn: `<button class="btn btn-quiet text-nowrap" data-request="${esc(x.id)}">Mark requested</button>` };
  if (x.status === 'nopg') { A.push(sell, consent); A.push(x.loanFit ? loan : qr); }
  else if (x.status === 'low') { A.push(remind); A.push(x.loanFit ? loan : qr); A.push(x.loanFit ? qr : consent); }
  else if (x.status === 'dormant') { A.push(reeng, sell, consent); }
  else { if (x.loanFit) A.push(loan); A.push(remind, qr); }
  if (x.branch_coverage === 'partial') {
    const na = x.branch_mix.na || 0;
    A.unshift({ tone: ['var(--mcb-orange-soft)', 'var(--mcb-orange-ink)'], t: `Set up the MCB gateway at the ${na} branch${na === 1 ? '' : 'es'} that don't have it`,
      d: `${branchesOn(x.branch_mix)} of ${x.branches} branches already collect through an MCB gateway${x.gateways.length ? ' (' + esc(x.gateways.join(', ')) + ')' : ''}. The same contract and setup can be extended to the rest — no new institute-level sale needed.`,
      imp: `Institute is ${pct(x.share * 100)} online today; fully covered institutes average higher`, btn: `<button class="btn btn-primary text-nowrap" data-add-deal="${esc(x.id)}|Drive adoption">Add to pipeline</button>` });
  }
  if (x.partner_status === 'non_partner') {
    A.splice(1, 0, { tone: ['var(--mcb-blue-soft)', 'var(--mcb-blue-ink)'], t: 'Move to an MCB partner gateway',
      d: `Online collections run on ${esc(x.gateways.join(', '))}, which ${x.gateways.length > 1 ? 'are' : 'is'} not an MCB partner — MCB earns nothing on ${rs(x.pg)} in ${win}.`,
      imp: `${rs(x.pg * x.annualise)} a year of gateway volume to bring onto a partner`, btn: `<button class="btn btn-quiet text-nowrap" data-add-deal="${esc(x.id)}|Activate PG">Add to pipeline</button>` });
  }
  $('#i360Nba').innerHTML = A.slice(0, 3).map((a, i) => `<div class="nba"><span class="nba-num" style="background:${a.tone[0]};color:${a.tone[1]}">${i + 1}</span>
    <div class="d-flex flex-column gap-1"><b>${a.t}</b><span class="fs-7 text-muted-2">${a.d}</span><span class="fs-8 fw-semibold" style="color:${a.tone[1]}">${a.imp}</span></div>${a.btn}</div>`).join('');

  // ---- Worth online ----
  $('#conv360').value = S.conv360;
  $('#conv360Out').textContent = S.conv360 + '%';
  const extraYr = x.off * x.annualise * S.conv360 / 100;
  $('#i360Gmv').textContent = rs(extraYr);
  $('#i360Share').textContent = x.tot ? pct(100 * (x.pg + x.off * S.conv360 / 100) / x.tot) : '—';
  $('#i360Rev').textContent = rs(extraYr * r.take);
  fill('.takeLbl', pct(r.take * 100, 2));

  // ---- Timeline: saved notes + monthly facts ----
  const items = (extras ? extras.notes : []).map((n) => ({ when: fmtDate(n.created_at.slice(0, 10)), dot: P.pg, text: n.text + (n.follow_up ? ' · follow up ' + fmtDay(n.follow_up) : '') }));
  for (let i = x.months.length - 1; i >= 0; i--) {
    const [pg, off] = x.months[i], m = months[i] + ' ' + yearOf(months[i], S.fy);
    let text;
    if (pg + off === 0) text = 'No collections recorded.';
    else if (pg > 0 && pg <= 2) text = `${rs(pg)} gateway test payment; ${rs(off)} offline.`;
    else if (pg > 2) text = `${rs(pg)} through the gateway (${pct(100 * pg / (pg + off))} of the month); ${rs(off)} offline.`;
    else text = `${rs(off)} collected offline, no gateway use.`;
    items.push({ when: m, dot: pg > 2 ? P.pg : P.oth, text });
  }
  $('#i360Timeline').innerHTML = (extras ? '' : '<div class="fs-8 text-faint pb-2">Loading notes…</div>') +
    items.map((t) => `<div class="tl"><span class="fs-8 text-muted-2">${esc(t.when)}</span><span class="tl-dot" style="background:${t.dot}"></span><span>${esc(t.text)}</span></div>`).join('');

  $('#i360Remind').disabled = false;
  $('#i360Remind').title = locked(x) ? 'No channel has granted consent yet' : '';

  if (!extras) {
    loadInstituteExtras(x.id).then(() => { if (S.instId === x.id && !sec.hidden) renderInstitute(x.id); }).catch(toastError);
  }
}
