/* VIEW 6 · UPSELL PIPELINE */
import { D, S, instById, rawInst } from '../store.js';
import { api } from '../api.js';
import { esc, nf, rs, sum } from '../format.js';
import { PLAY_LABEL, playChip } from '../metrics.js';
import { $, $$, chip, avatar, toast, toastError, showModal } from '../ui.js';

const PLAYS = [['all', 'All deals'], ['Activate PG', PLAY_LABEL['Activate PG']], ['Drive adoption', PLAY_LABEL['Drive adoption']], ['Add loan partner', PLAY_LABEL['Add loan partner']], ['Re-engage', PLAY_LABEL['Re-engage']]];

function dealValue(d) {
  const x = instById(d.institute_id);
  if (!x || d.loan_only || d.stage === 'lv') return 0;
  return x.revYr;
}

export function renderPipeline() {
  const stages = D.pipe.stages;
  const prob = Object.fromEntries(stages.map((s) => [s.id, s.prob]));
  const deals = D.pipe.deals.filter((d) => S.play === 'all' || d.play === S.play);
  $('#playFilter').innerHTML = PLAYS.map((p) => `<button type="button" class="pill" aria-pressed="${S.play === p[0]}" data-play="${esc(p[0])}">${p[1]}<span class="count">${D.pipe.deals.filter((d) => p[0] === 'all' || d.play === p[0]).length}</span></button>`).join('');
  $('#kanban').innerHTML = stages.map((s) => {
    const list = deals.filter((d) => d.stage === s.id);
    const v = sum(list.map(dealValue));
    return `<section class="kcol" data-stage="${s.id}" aria-label="${esc(s.name)}">
      <div class="px-1 pb-1"><div class="d-flex justify-content-between align-items-center"><b class="fs-7">${esc(s.name)}</b><span class="badge rounded-pill text-bg-light">${list.length}</span></div>
      <div class="fs-8 text-muted-2">${v ? rs(v) + '/yr' : s.id === 'lv' ? 'Won' : '—'} · ${s.id === 'lv' ? 'counted as won' : Math.round(s.prob * 100) + '% likely'}</div></div>
      ${list.map((d) => card(d, s.id, stages)).join('')}</section>`;
  }).join('');
  const open = deals.filter((d) => d.stage !== 'lv');
  $('#pOpen').textContent = rs(sum(open.map(dealValue))) + '/yr';
  $('#pOpenN').textContent = open.length + ' open deals in this view';
  const weighted = sum(open.map((d) => dealValue(d) * prob[d.stage]));
  $('#pWeighted').textContent = rs(weighted) + '/yr';
  $('#pWeightedSub').textContent = stages.filter((s) => s.id !== 'lv').map((s) => Math.round(s.prob * 100) + '%').join(' → ');
  $('#pStalled').textContent = open.filter((d) => d.days > 14).length;
  const target = D.settings.quarter_target_rs;
  $('#pTarget').textContent = target ? rs(target) : 'Not set';
  $('#pTargetSub').textContent = target ? `${Math.round(100 * weighted / 4 / target)}% covered by weighted pipeline this quarter` : 'Set it in Revenue settings';

  const ownerIds = [...new Set([...D.meta.owners.map((o) => o.id), ...D.pipe.deals.map((d) => d.owner).filter(Boolean)])];
  const owners = ownerIds.map((id) => {
    const mine = D.pipe.deals.filter((d) => d.owner === id && d.stage !== 'lv');
    return { id, n: mine.length, w: sum(mine.map((d) => dealValue(d) * prob[d.stage])), live: D.pipe.deals.filter((d) => d.owner === id && d.stage === 'lv').length };
  });
  const maxW = Math.max(...owners.map((o) => o.w), 0) || 1;
  $('#scoreboard').innerHTML = owners.length ? owners.map((o) => `<div class="col"><div class="d-flex align-items-center gap-3 border rounded-3 p-3"><span class="avatar" style="width:38px;height:38px">${esc(o.id)}</span>
    <div class="flex-grow-1" style="min-width:0"><div class="d-flex justify-content-between gap-2"><b>${o.n} deals</b><b class="text-violet">${rs(o.w)}</b></div>
    <div class="progress my-1" style="height:6px" role="progressbar" aria-label="${esc(o.id)} weighted upside" aria-valuenow="${(100 * o.w / maxW).toFixed(0)}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${(100 * o.w / maxW).toFixed(1)}%;background:var(--mcb-violet)"></div></div>
    <span class="fs-8 text-muted-2">${o.live} live · weighted upside / yr</span></div></div></div>`).join('')
    : '<div class="col-12 text-muted-2 fs-7">No owners yet. Add them with MCB_OWNERS in backend/.env and assign institutes from the Institutes page.</div>';
}

function card(d, stage, stages) {
  const x = instById(d.institute_id) || rawInst(d.institute_id) || { id: d.institute_id, name: d.institute_id };
  const stalled = stage !== 'lv' && d.days > 14;
  let metric = x.off != null ? 'Offline ' + rs(x.off) : 'Not in this FY', value = rs(dealValue(d)) + '/yr';
  if (d.loan_only && x.perStu != null) { metric = rs(x.perStu) + ' per paying student'; value = 'Loan fee'; }
  if (stage === 'lv' && x.lastPg != null) { metric = 'Gateway, last month'; value = rs(x.lastPg); }
  const moves = stages.filter((s) => s.id !== stage).map((s) => `<li><button class="dropdown-item" data-move="${esc(d.id)}|${s.id}">${esc(s.name)}</button></li>`).join('');
  return `<article class="kcard ${stalled ? 'stalled' : ''} ${stage === 'lv' ? 'won' : ''}" draggable="true" data-deal="${esc(d.id)}">
    <div class="d-flex justify-content-between align-items-start gap-2"><a href="#institute/${encodeURIComponent(x.id)}" class="fw-650 text-reset text-decoration-none fs-7" style="line-height:1.3">${esc(x.name)}</a>
      <div class="dropdown"><button class="btn btn-sm btn-link text-reset p-0" style="min-height:28px" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Move ${esc(x.name)}"><svg class="bi" aria-hidden="true" focusable="false"><use href="#bi-three-dots"></use></svg></button><ul class="dropdown-menu dropdown-menu-end"><li><span class="dropdown-header">Move to</span></li>${moves}<li><hr class="dropdown-divider"></li><li><button class="dropdown-item text-danger" data-remove-deal="${esc(d.id)}">Remove from pipeline</button></li></ul></div></div>
    <span>${playChip(d.play)}</span>
    <div class="d-flex justify-content-between gap-2 fs-8 text-muted-2"><span>${metric}</span><b class="text-violet">${value}</b></div>
    <div class="knext">${esc(d.next)}</div>
    <div class="d-flex justify-content-between align-items-center">${avatar(d.owner)}<span class="fs-8 fw-semibold ${stage === 'lv' ? 'text-green' : stalled ? 'text-orange' : 'text-faint'}">${stage === 'lv' ? 'Live' : stalled ? d.days + 'd · stalled' : d.days + 'd in stage'}</span></div>
  </article>`;
}

/** Take a deal off the board after a confirmation; the school's activity keeps a record. */
export async function removeDeal(id) {
  const d = D.pipe.deals.find((x) => x.id === id);
  if (!d) return;
  const x = instById(d.institute_id) || rawInst(d.institute_id) || { name: d.institute_id };
  if (!confirm(`Remove ${x.name} (${d.play}) from the pipeline?`)) return;
  try {
    await api.removeDeal(id);
    D.pipe.deals = D.pipe.deals.filter((y) => y.id !== id);
    renderPipeline();
    toast(`Removed ${x.name} from the pipeline`);
  } catch (err) { toastError(err); }
}

export async function moveDeal(id, stage) {
  const d = D.pipe.deals.find((x) => x.id === id);
  if (!d || d.stage === stage) return;
  const prev = { stage: d.stage, days: d.days };
  Object.assign(d, { stage, days: 0 });           // optimistic
  renderPipeline();
  try {
    Object.assign(d, await api.moveDeal(id, stage));
    toast('Moved to ' + D.pipe.stages.find((s) => s.id === stage).name);
  } catch (err) {
    Object.assign(d, prev); renderPipeline(); toastError(err);
  }
}

/** "Add to pipeline" asks only for the owner: a Fintech user from dbo.Users. Resolves to the name, or null if cancelled. */
let ownersCache = null;
export async function pickOwner(what) {
  if (!ownersCache) ownersCache = await api.pipelineOwners();
  const el = $('#ownerModal'), sel = $('#ownerPick'), go = $('#ownerGo');
  $('#ownerFor').textContent = what;
  sel.innerHTML = '<option value="">Choose an owner…</option>' + ownersCache.map((o) => `<option value="${esc(o.name)}">${esc(o.name)}</option>`).join('');
  $('#ownerNone').hidden = ownersCache.length > 0;
  go.disabled = true;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; sel.onchange = null; go.onclick = null; el.removeEventListener('hidden.bs.modal', onHide); resolve(v); };
    const onHide = () => finish(null);
    sel.onchange = () => { go.disabled = !sel.value; };
    go.onclick = () => finish(sel.value || null);           // the button also closes the pop-up (data-bs-dismiss)
    el.addEventListener('hidden.bs.modal', onHide);
    showModal(el);
  });
}

/** Add one deal; returns true when created. */
export async function addDeal(instituteId, play, extra = {}) {
  const x = instById(instituteId);
  try {
    const deal = await api.addDeal({ institute_id: instituteId, play, loan_only: play === 'Add loan partner' && x && x.status !== 'live', ...extra });
    D.pipe.deals.push(deal);
    return true;
  } catch (err) {
    if (err.status === 409) return false;
    throw err;
  }
}

export function bindPipelineEvents() {
  const k = $('#kanban');
  k.addEventListener('dragstart', (e) => { const c = e.target.closest('[data-deal]'); if (c) e.dataTransfer.setData('text/plain', c.dataset.deal); });
  k.addEventListener('dragover', (e) => { const col = e.target.closest('.kcol'); if (col) { e.preventDefault(); $$('.kcol').forEach((c) => c.classList.toggle('drop', c === col)); } });
  k.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) $$('.kcol').forEach((c) => c.classList.remove('drop')); });
  k.addEventListener('drop', (e) => {
    const col = e.target.closest('.kcol'); if (!col) return;
    e.preventDefault(); $$('.kcol').forEach((c) => c.classList.remove('drop'));
    moveDeal(e.dataTransfer.getData('text/plain'), col.dataset.stage);
  });
}
