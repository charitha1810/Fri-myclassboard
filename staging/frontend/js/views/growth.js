/* Commission growth panel, AI suggestions and the live-database badge. */
import { D, S, INST, gfParams } from '../store.js';
import { registerList } from './instPopup.js';
import { api } from '../api.js';
import { esc, nf, rs, cr } from '../format.js';
import { $, chip, toastError } from '../ui.js';

const LEVER_ICON = { convert_offline: '₹→', switch_gateway: '⇄', onboard_branches: '⊕', onboard_na: '★' };

// ---------------- Commission ----------------
export function renderCommission() {
  const c = D.comm;
  if (!c) return;
  $('#commNow').textContent = rs(c.commission_yr_rs);
  $('#commNowSub').textContent = `${(c.rate_bps / 100).toFixed(2)}% of the ${cr(c.earning_volume_yr_rs / 1e7, 0)} a year that parents pay online through our partner gateways`;
  const total = c.levers.reduce((a, l) => a + l.commission_yr_rs, 0);
  // "List them all" lists the schools matching the lever's filter in a pop-up (the same set the Institutes filter gives).
  const inFilter = (x, f) => (!f.partner || x.partner_status === f.partner) && (!f.coverage || x.branch_coverage === f.coverage)
    && (!f.gateway || x.gateways.includes(f.gateway)) && (!f.gw_kind || (x.branch_gateways || []).some((g) => g.kind === f.gw_kind));
  c.levers.forEach((l) => registerList('lever:' + l.key, esc(l.title), INST().filter((x) => inFilter(x, l.filter || {})).sort((a, b) => b.tot - a.tot), 'biggest fees first'));
  $('#commLevers').innerHTML = c.levers.map((l, i) => `<div class="col"><div class="lever">
      <span class="fs-8 text-muted-2 fw-semibold">Way ${i + 1}</span>
      <span class="fs-7 fw-semibold">${LEVER_ICON[l.key] || ''} ${esc(l.title)}</span>
      <span class="v">+${rs(l.commission_yr_rs)}<span class="fs-8 fw-normal text-muted-2"> extra commission / yr</span></span>
      <span class="fs-8 text-muted-2">${nf(l.institutes)} institutes · ${cr(l.volume_yr_rs / 1e7, 0)} / yr more fees through our partner gateways</span>
      <span class="fs-8">${esc(l.how)}</span>
      <div class="d-flex gap-2 mt-auto pt-1">
        <button type="button" class="btn btn-sm btn-quiet" data-lever="${l.key}" ${l.institutes ? '' : 'disabled'}>See top institutes</button>
        <a class="btn btn-sm btn-link" href="#command" data-list-popup="lever:${l.key}">List them all</a>
      </div></div></div>`).join('');
  $('#commNote').textContent = `Together up to +${rs(total)} / yr, assuming ${c.conv_pct}% of the money in each case moves to our partner gateways. Some schools appear in more than one, so don't add them up exactly.${c.loan_fee_yr_rs ? ` Loan fees add ${rs(c.loan_fee_yr_rs)} / yr.` : ''}`;
}

export function showLever(key) {
  const l = (D.comm?.levers || []).find((x) => x.key === key);
  if (!l) return;
  $('#commDetailTitle').textContent = `${l.title}: biggest ${l.top.length} of ${nf(l.institutes)} institutes`;
  $('#commDetailRows').innerHTML = l.top.map((r) => `<tr>
      <td><a href="#institute/${encodeURIComponent(r.id)}" class="fw-650 text-reset text-decoration-none">${esc(r.name)}</a></td>
      <td class="fs-8 text-muted-2" style="max-width:200px">${esc(r.gateways.join(', ') || '—')}</td>
      <td class="text-end tnum">${rs(r.collected_rs)}</td><td class="text-end tnum text-violet">${rs(r.online_rs)}</td><td class="text-end tnum text-orange">${rs(r.offline_rs)}</td>
      <td class="text-end tnum">${rs(r.volume_rs)}</td><td class="text-end tnum fw-semibold text-violet">${rs(r.commission_yr_rs)}</td>
      <td class="fs-8 text-muted-2">${esc(r.note)}</td></tr>`).join('');
  $('#commDetail').hidden = false;
  $('#commDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- AI suggestions ----------------
const PRIO = { high: 'orange', medium: 'amber', low: 'gray' };
const LEVER_NAME = { convert_offline: 'Move cash & cheques online', switch_gateway: 'Switch to partner gateway', onboard_branches: 'Add remaining branches', onboard_na: 'Sign up new school', loan_emi: 'Loan / EMI', re_engage: 'Re-engage', other: 'Other' };

function linkInstitutes(names) {
  const all = D.opts?.institutes || [];
  return names.map((n) => {
    const hit = all.find((o) => o.label.toLowerCase().startsWith(n.toLowerCase() + ' — ')) || all.find((o) => o.label.toLowerCase().startsWith(n.toLowerCase()));
    return hit ? `<a href="#institute/${encodeURIComponent(hit.value)}">${esc(n)}</a>` : esc(n);
  }).join(' · ');
}

function renderAnswer(el, a) {
  const when = new Date(a.generated_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<div class="ai-head">${esc(a.headline)}</div>`
    + a.suggestions.map((s, i) => `<div class="ai-sugg">
        <div class="d-flex flex-column gap-1">
          <div class="d-flex flex-wrap align-items-center gap-2"><b>${i + 1}. ${esc(s.title)}</b>${chip(s.priority + ' priority', PRIO[s.priority] || 'gray')}${chip(LEVER_NAME[s.lever] || s.lever, 'violet')}</div>
          <div class="fs-7"><span class="text-muted-2">Why:</span> ${esc(s.why)}</div>
          <div class="fs-7"><span class="text-muted-2">Do next:</span> ${esc(s.action)}</div>
          ${s.institutes.length ? `<div class="fs-8"><span class="text-muted-2">Institutes:</span> ${linkInstitutes(s.institutes)}</div>` : ''}
        </div>
        <div class="imp">${s.expected_commission_lakh_yr ? `<div class="fs-5 fw-bold text-violet">+${rs(s.expected_commission_lakh_yr * 1e5)}</div><div class="fs-8 text-muted-2">commission / yr</div>` : ''}
          ${s.expected_volume_cr ? `<div class="fs-8 text-muted-2">+${cr(s.expected_volume_cr)} volume / yr</div>` : ''}</div>
      </div>`).join('')
    + (a.data_notes.length ? `<div class="fs-8 text-muted-2"><b>Data notes:</b> ${a.data_notes.map(esc).join(' · ')}</div>` : '')
    + `<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 fs-8 text-faint">
        <span>Generated ${when}${a.cached ? ' · reused (same data snapshot)' : ''} · AI estimates — verify before committing to a customer.</span>
        <button type="button" class="btn btn-sm btn-link" data-ai-run="${a.scope.startsWith('one school') ? 'institute' : 'portfolio'}" data-ai-refresh="1">Regenerate</button></div>`;
}

export async function runSuggestions(kind, refresh) {
  const el = kind === 'institute' ? $('#aiOutInst') : $('#aiOut');
  const btns = document.querySelectorAll(`[data-ai-run="${kind}"]`);
  btns.forEach((b) => { b.disabled = true; });
  el.innerHTML = `<div class="ai-loading"><div class="spinner-border spinner-border-sm" aria-hidden="true"></div>Reading the live figures${kind === 'institute' ? ' for this school' : ' for the current filters'}… this can take up to a minute.</div>`;
  try {
    const body = { refresh: !!refresh, institute_id: kind === 'institute' ? S.instId : null };
    const p = kind === 'institute' ? { fy: S.fy, from: S.gf.from, to: S.gf.to, modes: S.gf.modes, rate: S.gf.rate } : gfParams();
    renderAnswer(el, await api.suggestions(p, body));
  } catch (err) {
    el.innerHTML = `<div class="alert-item" style="background:var(--mcb-orange-soft)"><span><b>Suggestions are not available right now.</b> ${esc(err.message)}</span></div>`;
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

export function resetSuggestions(kind) {
  const el = kind === 'institute' ? $('#aiOutInst') : $('#aiOut');
  if (el) el.innerHTML = '<div class="fs-7 text-muted-2">Press “Get suggestions”. Only the aggregated figures on this screen are used — no student or parent data.</div>';
}

export async function paintAiStatus() {
  try {
    const s = await api.aiStatus();
    $('#aiMeta').textContent = s.enabled ? '' : ' · currently unavailable';
  } catch (e) { $('#aiMeta').textContent = ''; }
}

// ---------------- Live database badge ----------------
export async function verifyLive() {
  const b = $('#liveBadge');
  try {
    const v = await api.verify(S.fy);
    const snap = new Date(v.snapshot).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    b.className = 'live-badge ' + (v.ok ? 'ok' : 'warn');
    $('#liveText').textContent = v.ok ? `Live · verified` : 'Live · totals differ';
    b.title = `Connected to MCBMaster. Data snapshot ${snap}. Checked ${new Date(v.checked_at).toLocaleTimeString('en-IN')}: `
      + `database ${rs(v.database.amount_rs)} · ${nf(v.database.transactions)} txns · ${nf(v.database.institutes)} institutes; `
      + `portal ${rs(v.portal.amount_rs)} · ${nf(v.portal.transactions)} txns · ${nf(v.portal.institutes)} institutes. Click to re-check.`;
  } catch (err) {
    b.className = 'live-badge down';
    $('#liveText').textContent = 'Database offline';
    b.title = err.message + ' Click to retry.';
  }
}
export function markDown(err) {
  const b = $('#liveBadge');
  b.className = 'live-badge down';
  $('#liveText').textContent = 'Database offline';
  b.title = (err && err.message) || 'The database could not be reached.';
}
