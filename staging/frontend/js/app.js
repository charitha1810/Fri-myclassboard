/* Boot, data loading, routing and event wiring. */
import { api } from './api.js';
import { D, S, invalidate, rawInst, instById, gfParams } from './store.js';
import { VIEW_FILTERS, activate, restoreFilters, validateFilters, fillFilterBars, syncBar, bindFilterBars, presetFilters } from './filters.js';
import { esc } from './format.js';
import { locked } from './metrics.js';
import { repaintAll, theme } from './chart.js';
import { applyLang, savedLang, lang } from './lang.js';
import { $, $$, ic, toast, toastError, busy, showModal, hideOffcanvas } from './ui.js';
import { renderCommand } from './views/command.js';
import { renderInstitutes, fillFilterOptions, resetFilters, instFiltered, exportCsv, resolvePick } from './views/institutes.js';
import { renderSegments, renderBranchCoverage, renderOrgs, bindOrgEvents } from './views/orgs.js';
import { bindExportPreview } from './exportPreview.js';
import { renderCommission, showLever, runSuggestions, resetSuggestions, paintAiStatus, verifyLive, markDown } from './views/growth.js';
import { renderInstitute, loadInstituteExtras, dropInstituteExtras, clearInstituteExtras } from './views/institute360.js';
import { openInstPopup, openListPopup, openRankPopup, reopenList, listMore, curListKey, monthMore, openMonthPopup, openMonthsPopup, openBranchPopup } from './views/instPopup.js';
import { renderCoverage, renderLoans, renderMaster, MASTER } from './views/coverage.js';
import { renderCampaigns, bindCampaignEvents } from './views/campaigns.js';
import { renderPipeline, bindPipelineEvents, moveDeal, removeDeal, addDeal, pickOwner } from './views/pipeline.js';
import { renderTemplates } from './views/templates.js';
import { renderWaReport, initWaReport } from './views/wareport.js';
import { renderDueMonths, initDueMonths } from './views/duemonths.js';
import { syncSettingsForm, bindSettingsEvents, renderConsent, setConsent, requestConsent } from './views/setup.js';

/* ---------------- Data ----------------
   Each section has its own filters (filters.js). Its figures are fetched for exactly those filters when the
   section is shown; recent result sets are kept so switching back is instant. */
const scopeCache = new Map();
const SCOPE_CACHE_MAX = 8;

/** Load a financial year: reference data (options, settings, pipeline). Section figures load on render. */
async function loadFy(fy) {
  document.body.classList.add('refreshing');
  try {
    const meta = await api.meta(fy);
    S.fy = meta.fy;
    const [settings, opts, pipe] = await Promise.all([api.settings(), api.filterOptions(S.fy), api.pipeline()]);
    Object.assign(D, { meta, settings, opts, pipe });
    validateFilters();
    scopeCache.clear(); D.key = null;
    clearInstituteExtras();
    paintShell();
    fillFilterOptions();
    fillFilterBars();
    syncSettingsForm();
  } finally {
    document.body.classList.remove('refreshing');
  }
}

/** Make `view` active and make sure D holds the figures for its filters. */
async function ensureData(view) {
  activate(view);
  const p = gfParams();
  const key = JSON.stringify(p);
  if (D.key === key) return;
  let data = scopeCache.get(key);
  if (!data) {
    const [modes, gw, loans, inst, alerts, gmaster, comm] = await Promise.all([
      api.paymentModes(p), api.gateways(p), api.loans(p), api.institutes(p), api.alerts(p), api.gatewayMaster(p), api.commission(p)
    ]);
    data = { modes, gw, loans, inst, alerts, gmaster, comm };
    scopeCache.set(key, data);
    if (inst.account_ready === false) setTimeout(() => fillAccounts(p, inst, 1), 15000);
    if (scopeCache.size > SCOPE_CACHE_MAX) scopeCache.delete(scopeCache.keys().next().value);
  }
  Object.assign(D, data);
  D.key = key;
  invalidate();
}

/** Just after a server start the account teams are still being read: fetch them again until they are there,
 *  put them on the schools already loaded, and redraw. */
async function fillAccounts(p, inst, attempt) {
  try {
    const fresh = await api.institutes(p);
    if (fresh.account_ready === false) { if (attempt < 12) setTimeout(() => fillAccounts(p, inst, attempt + 1), 15000); return; }
    const by = new Map(fresh.institutes.map((x) => [x.id, x]));
    inst.institutes.forEach((x) => { const f = by.get(x.id); if (f) { x.account = f.account; x.account_manager = f.account_manager; } });
    inst.account_ready = true;
    if (D.inst === inst) { invalidate(); rerender(); }
  } catch (e) { /* the names simply stay empty until the next load */ }
}

/** A section's filters changed: drop what belonged to the old filters and redraw that section. */
function onFilterChange(view) {
  if (view === 'command') { resetSuggestions('portfolio'); $('#commDetail').hidden = true; }
  if (view === 'institute') { clearInstituteExtras(); resetSuggestions('institute'); }
  if (view === 'institutes') { S.page = 1; S.sel.clear(); }
  if (current.view === view) rerender();
}
const dropScopeCache = () => { scopeCache.clear(); D.key = null; };

function paintShell() {
  const m = D.meta;
  $('#fy').innerHTML = m.fy_options.map((f) => `<option value="${esc(f)}" ${f === m.fy ? 'selected' : ''}>${esc(f)}</option>`).join('');
  $('#userAvatar').textContent = m.user.initials;
  $('#userEmail').textContent = m.user.email || 'Signed in';
  $('#notices').innerHTML = m.notices.map((n) => `<div class="alert-item" style="background:var(--mcb-amber-soft)">${ic('exclamation-triangle')}<span>${esc(n)}</span></div>`).join('');
}

function showLoadError(err) {
  const box = $('#loadState');
  box.hidden = false; box.classList.add('error');
  box.innerHTML = `<b class="fs-6">Could not load revenue data</b><span>${esc(err.message)}</span><button class="btn btn-quiet mt-2" id="retryLoad">Try again</button>`;
  $('#retryLoad').addEventListener('click', () => location.reload());
  $$('[data-view]').forEach((s) => { s.hidden = true; });
}

/* ---------------- Router ---------------- */
const TITLES = { command: 'Command Center', institutes: 'Institutes', institute: 'Institute 360', coverage: 'Gateways', loans: 'Loan partners', campaigns: 'Campaign studio', duemonths: 'Due month-wise organisations', wareport: 'WhatsApp report', templates: 'WhatsApp templates', pipeline: 'Upsell pipeline' };
const RENDER = {
  command: () => { renderCommand(); renderCommission(); renderSegments(); renderBranchCoverage(); renderOrgs(); }, institutes: () => renderInstitutes(), institute: (arg) => renderInstitute(arg || S.instId),
  coverage: () => { renderCoverage(); renderMaster(); }, loans: () => renderLoans(), campaigns: () => renderCampaigns(true), duemonths: () => renderDueMonths(), wareport: () => renderWaReport(), templates: () => renderTemplates(), pipeline: () => renderPipeline()
};
let current = { view: 'command', arg: '' };
let lastAiInst = null;

function go(view, arg) {
  const v = TITLES[view] ? view : 'command';
  const h = '#' + v + (arg ? '/' + encodeURIComponent(arg) : '');
  try { if (location.hash !== h) history.pushState(null, '', h); } catch (e) { /* hash blocked: still navigate */ }
  render(v, arg);
  try { window.scrollTo(0, 0); } catch (e) {}
}
function route() {
  let h = '';
  try { h = location.hash.slice(1); } catch (e) {}
  const i = h.indexOf('/');
  render(i < 0 ? (h || 'command') : h.slice(0, i), i < 0 ? '' : decodeURIComponent(h.slice(i + 1)));
}
/** Show `sec` with only its header and filter bar plus a "no data" message (filters left nothing to show). */
function setEmpty(sec, view, on) {
  sec.classList.toggle('is-empty', on);
  let box = sec.querySelector('.vf-empty');
  if (on && !box) {
    sec.querySelector('.vfbar').insertAdjacentHTML('afterend', `<div class="vf-empty text-center py-5">
      <div class="fw-bold fs-6">No data for these filters</div>
      <div class="text-muted-2 mt-1">No institute collected anything in the selected months with this combination of filters.</div>
      <button type="button" class="btn btn-quiet mt-3" data-f-clear data-f-clear-view="${view}">Clear filters</button></div>`);
  }
}

let renderSeq = 0;
async function render(view, arg) {
  if (!D.opts) return;
  const v = TITLES[view] ? view : 'command';
  current = { view: v, arg: arg || '' };
  const seq = ++renderSeq;
  const navKey = v === 'institute' ? 'institutes' : v;
  $$('[data-nav]').forEach((a) => { const on = a.dataset.nav === navKey; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  document.title = TITLES[v] + ' · MCB Revenue Intelligence';
  hideOffcanvas($('#sidebar'));

  // Figures for this section's own filters (sections without filters use the full FY).
  document.body.classList.add('refreshing');
  try { await ensureData(v); }
  catch (err) { toastError(err); return; }
  finally { document.body.classList.remove('refreshing'); }
  if (seq !== renderSeq) return;                 // the user already moved on
  $('#loadState').hidden = true;
  $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== v; });
  const sec = document.querySelector(`[data-view="${v}"]`);
  if (VIEW_FILTERS[v]) syncBar(v);
  // Filters that leave nothing to show: one clear message instead of empty charts (a school page still renders).
  const empty = !!VIEW_FILTERS[v] && v !== 'institute' && (!D.inst.institutes.length || !D.modes.months.length);
  if (sec.querySelector('.vfbar')) setEmpty(sec, v, empty);
  if (empty) return;
  const old = sec.querySelector('.render-error'); if (old) old.remove();
  if (v === 'institute' && arg !== lastAiInst) { resetSuggestions('institute'); lastAiInst = arg; }
  try { RENDER[v](arg); }
  catch (err) {
    console.error('Render failed for ' + v, err);
    sec.insertAdjacentHTML('afterbegin', `<div class="alert alert-danger render-error" role="alert">This screen could not be drawn: ${esc(err.message)}. The rest of the portal still works.</div>`);
  }
}
const rerender = () => render(current.view, current.arg);

/* ---------------- Actions ---------------- */
async function addDealAndToast(id, play) {
  const x = rawInst(id);
  try {
    const owner = await pickOwner(x ? x.name : id);
    if (!owner) return;
    const created = await addDeal(id, play, { owner });
    toast(created ? `Added ${x ? x.name : id} to the pipeline · owner ${owner}` : `${x ? x.name : id} is already in the pipeline for this play`);
    if (current.view === 'pipeline') renderPipeline();
    if (current.view === 'institute' && created) renderInstitute(id);    // owner name in the header
  } catch (err) { toastError(err); }
}

async function assignOwner(owner) {
  const ids = [...S.sel];
  try {
    await api.assignOwner(ids, owner);
    D.inst.institutes.forEach((i) => { if (S.sel.has(i.id)) i.owner = owner; });
    invalidate(); D.opts = await api.filterOptions(S.fy); fillFilterOptions();
    toast(owner ? `Assigned ${ids.length} institute${ids.length > 1 ? 's' : ''} to ${owner}` : `Unassigned ${ids.length} institute${ids.length > 1 ? 's' : ''}`);
    renderInstitutes();
  } catch (err) { toastError(err); }
}

function openCampaignFor(ids) {
  const ok = ids.filter((id) => { const x = rawInst(id); return x && !locked(x); });
  const skipped = ids.length - ok.length;
  S.camp.scope = 'selected'; S.camp.sel = new Set(ok);
  go('campaigns');
  if (skipped) setTimeout(() => toast(`${skipped} institute${skipped > 1 ? 's' : ''} skipped — no reminder consent yet`), 50);
}

// Boxes and table rows that act as buttons also answer to Enter / Space.
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-months-popup], [data-month-open]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('input', (e) => { if (e.target.id === 'instPopFind') openListPopup(e.target.dataset.listKey, e.target.value); });
document.addEventListener('click', (e) => {
  const br = e.target.closest('[data-branch-popup]');
  if (br) { e.preventDefault(); openBranchPopup(br.dataset.branchPopup, !!br.closest('#instModal')); return; }
  // Every school link opens the details pop-up; only its "Open full page" button goes to the school page.
  const pop = e.target.closest('[data-inst-popup], a[href^="#institute/"]:not(#instPopOpen)');
  if (pop) {
    e.preventDefault();
    const id = pop.dataset.instPopup || decodeURIComponent(pop.getAttribute('href').slice('#institute/'.length));
    if (!openInstPopup(id, pop.dataset.fromList || '')) go('institute', id);   // not in the figures on screen
    return;
  }
  const mr = e.target.closest('[data-rank]');
  if (mr) { e.preventDefault(); openRankPopup(mr.dataset.rank); return; }
  const lp = e.target.closest('[data-list-popup]');
  if (lp) { e.preventDefault(); openListPopup(lp.dataset.listPopup); return; }
  const lm = e.target.closest('[data-list-more]');
  if (lm) { listMore(lm.dataset.listMore, ($('#instPopFind') || {}).value || ''); return; }
  if (e.target.closest('[data-month-more]')) { monthMore(); return; }
  const allMonths = e.target.closest('[data-months-popup]');
  if (allMonths) { openMonthsPopup({ inst: allMonths.dataset.monthsPopup, kind: allMonths.dataset.kind || 'all' }); return; }
  const oneMonth = e.target.closest('[data-month-open]');
  if (oneMonth) { openMonthPopup({ kind: oneMonth.dataset.kind || 'all', month: oneMonth.dataset.monthOpen, inst: oneMonth.dataset.inst || '', back: 'months:' }); return; }
  const back = e.target.closest('[data-list-back]');
  if (back) { reopenList(curListKey()); return; }
  const mk = e.target.closest('[data-master-kind]');
  if (mk) { MASTER.kind = mk.dataset.masterKind; renderMaster(); }
  const lv = e.target.closest('[data-lever]');
  if (lv) showLever(lv.dataset.lever);
  // Tiles and levers open the Institutes section with its filters preset (other sections keep theirs).
  const keepMonths = () => ({ rate: S.gf.rate });
  const lf = e.target.closest('[data-lever-filter]');
  if (lf) {
    let f = {};
    try { f = JSON.parse(lf.dataset.leverFilter); } catch (err) {}
    resetFilters(); presetFilters('institutes', { ...keepMonths(), ...f }); onFilterChange('institutes');
  }
  const ai = e.target.closest('[data-ai-run]');
  if (ai) { runSuggestions(ai.dataset.aiRun, !!ai.dataset.aiRefresh); return; }
  const pp = e.target.closest('[data-partner-preset]');
  if (pp) { resetFilters(); presetFilters('institutes', { ...keepMonths(), partner: pp.dataset.partnerPreset }); onFilterChange('institutes'); }
  const cp = e.target.closest('[data-coverage-preset]');
  if (cp) { resetFilters(); S.sort = 'tot'; S.sortDir = -1; presetFilters('institutes', { ...keepMonths(), coverage: cp.dataset.coveragePreset }); onFilterChange('institutes'); }
  const t = e.target.closest('[data-preset],[data-view-key],[data-sort],[data-play],[data-move],[data-remove-deal],[data-add-deal],[data-camp-inst],[data-request],[data-assign],[data-jump],[data-token],[data-consent]');
  if (t) {
    const ds = t.dataset;
    if (ds.preset) { resetFilters(ds.preset); }
    if (ds.viewKey) { S.view = ds.viewKey; S.page = 1; renderInstitutes(); }
    if (ds.sort) { S.sortDir = S.sort === ds.sort ? -S.sortDir : (ds.sort === 'name' ? 1 : -1); S.sort = ds.sort; renderInstitutes(); }
    if (ds.play) { S.play = ds.play; renderPipeline(); }
    if (ds.move) { const [id, st] = ds.move.split('|'); moveDeal(id, st); }
    if (ds.removeDeal) removeDeal(ds.removeDeal);
    if (ds.addDeal) { const i = ds.addDeal.lastIndexOf('|'); addDealAndToast(ds.addDeal.slice(0, i), ds.addDeal.slice(i + 1)); }
    if (ds.campInst) { e.preventDefault(); openCampaignFor([ds.campInst]); return; }
    if (ds.request) { busy(t, async () => { const n = await requestConsent(ds.request, refreshConsentViews); toast('Consent marked as requested for ' + n); }); }
    if ('assign' in ds) { assignOwner(ds.assign); }
    if (ds.jump) { e.preventDefault(); document.getElementById(ds.jump).scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (ds.consent) { const [id, ch, st] = ds.consent.split('|'); setConsent(id, ch, st, refreshConsentViews); }
  }
  const a = e.target.closest('a[href^="#"]');
  if (a && !a.hasAttribute('data-bs-toggle') && !a.hasAttribute('data-jump')) {
    const h = a.getAttribute('href').slice(1);
    const i = h.indexOf('/');
    const v = i < 0 ? h : h.slice(0, i), arg = i < 0 ? '' : decodeURIComponent(h.slice(i + 1));
    e.preventDefault();
    if (TITLES[v]) go(v, arg);
  }
});

function refreshConsentViews() {
  if (!$('#consentModal').classList.contains('show')) { rerender(); return; }
  renderConsent(); rerender();
}

/* ---------------- Command ---------------- */
$$('input[name="period"]').forEach((r) => r.addEventListener('change', () => { S.period = r.value; renderCommand(); }));
$('#shift').addEventListener('input', (e) => { S.shift = +e.target.value; renderCommand(); });

/* ---------------- Institutes ---------------- */
$('#resetFilters').addEventListener('click', () => { resetFilters(); renderInstitutes(); });
$('#instMore').addEventListener('click', () => { S.page += 1; renderInstitutes(); });
$('#instRows').addEventListener('change', (e) => { const id = e.target.dataset.sel; if (!id) return; if (e.target.checked) S.sel.add(id); else S.sel.delete(id); renderInstitutes(); });
$('#selAll').addEventListener('change', (e) => { instFiltered(false).forEach((x) => { if (e.target.checked) S.sel.add(x.id); else S.sel.delete(x.id); }); renderInstitutes(); });
$('#bulkClear').addEventListener('click', () => { S.sel.clear(); renderInstitutes(); });
$('#bulkPipeline').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const owner = await pickOwner(`${S.sel.size} selected institute${S.sel.size === 1 ? '' : 's'}`);
  if (!owner) return;
  let added = 0;
  for (const id of S.sel) { const x = instById(id); if (x && await addDeal(id, x.play, { owner })) added++; }
  const skipped = S.sel.size - added;
  toast(`Added ${added} institute${added === 1 ? '' : 's'} to the pipeline` + (skipped ? ` · ${skipped} already there` : ''));
}));
$('#bulkCampaign').addEventListener('click', () => openCampaignFor([...S.sel]));
$('#exportCsv').addEventListener('click', exportCsv);

/* ---------------- Institute 360 ---------------- */
$('#conv360').addEventListener('input', (e) => { S.conv360 = +e.target.value; renderInstitute(S.instId); });
$('#i360LogCall').addEventListener('click', () => { $('#i360Note').focus(); $('#i360Note').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#i360Pipeline').addEventListener('click', () => { const x = instById(S.instId); if (x) addDealAndToast(x.id, x.play); });
$('#i360Remind').addEventListener('click', () => {
  const x = rawInst(S.instId); if (!x) return;
  if (locked(x)) { toast('No reminder consent yet — record it in the Consent register first'); showModal($('#consentModal')); return; }
  openCampaignFor([x.id]);
});
$('#i360Save').addEventListener('click', (e) => {
  const text = $('#i360Note').value.trim(); if (!text) { $('#i360Note').focus(); return; }
  const id = S.instId;
  busy(e.currentTarget, async () => {
    await api.addNote(id, text, $('#i360Date').value || null);
    $('#i360Note').value = ''; $('#i360Date').value = '';
    dropInstituteExtras(id); await loadInstituteExtras(id, true);
    if (current.view === 'institute') renderInstitute(id);
    toast('Note saved');
  });
});

/* ---------------- School picker (Institutes page and Institute 360) ---------------- */
function openPicked(input) {
  if (!input.value.trim()) {            // emptied box: drop a "several matches" search and show every school again
    if (S.q) { S.q = ''; S.page = 1; if (current.view === 'institutes') renderInstitutes(); }
    return;
  }
  const hit = resolvePick(input.value);
  if (!hit) { toast('No school matches “' + input.value.trim() + '”'); return; }
  if (Array.isArray(hit)) {             // several matches: show them as a filtered list
    resetFilters(); S.q = input.value.trim(); go('institutes');
    toast(`${hit.length} schools match — pick one from the list`);
    return;
  }
  input.value = '';
  go('institute', hit.value);
}
$('#schoolPickForm').addEventListener('submit', (e) => { e.preventDefault(); openPicked($('#schoolPick')); });
$('#schoolPick').addEventListener('change', (e) => { const h = resolvePick(e.target.value); if (h && !Array.isArray(h)) openPicked(e.target); });
$('#i360PickForm').addEventListener('submit', (e) => { e.preventDefault(); openPicked($('#i360Pick')); });
$('#i360Pick').addEventListener('change', (e) => { const h = resolvePick(e.target.value); if (h && !Array.isArray(h)) openPicked(e.target); });

/* ---------------- Coverage ---------------- */
$$('input[name="gwSort"]').forEach((r) => r.addEventListener('change', () => { S.gwSort = r.value; renderCoverage(); }));
$$('input[name="gwSeg"]').forEach((r) => r.addEventListener('change', () => { S.gwSeg = r.value; renderCoverage(); }));
bindOrgEvents();
bindExportPreview();

/* ---------------- Campaigns, pipeline, setup ---------------- */
bindCampaignEvents();
bindPipelineEvents();
initWaReport();
initDueMonths();
// Revenue settings: redraw at once; after the save lands, refetch server figures (commission uses the saved rate).
let settingsTimer = null;
bindSettingsEvents(() => {
  rerender();
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { dropScopeCache(); fillFilterBars(); rerender(); }, 1200);
});
$('#consentModal').addEventListener('show.bs.modal', renderConsent);
$('#consentSearch').addEventListener('input', renderConsent);
$('#consentFilter').addEventListener('change', renderConsent);

/* ---------------- Top bar ---------------- */
$('#fy').addEventListener('change', (e) => busy(e.target, async () => { await loadFy(e.target.value); rerender(); }));
$('#refreshBtn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  await api.refresh(); await loadFy(S.fy); $('#newData').hidden = true; rerender(); verifyLive(); toast('Data reloaded from the database');
}));
$('#logoutBtn').addEventListener('click', async () => { try { await api.logout(); } finally { location.replace('/login'); } });
const applyThemeIcon = () => { $('#themeBtn').innerHTML = ic(theme() === 'dark' ? 'sun' : 'moon-stars'); };
$('#themeBtn').addEventListener('click', () => {
  const t = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-bs-theme', t);
  try { localStorage.setItem('mcb-theme', t); } catch (e) {}
  applyThemeIcon(); rerender(); repaintAll();
});
// Simple / Advanced wording: swap static text now, rebuild filter bars and the screen for JS-built text.
applyLang(savedLang());
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang-btn]');
  if (!b || lang() === b.dataset.langBtn) return;
  applyLang(b.dataset.langBtn);
  if (D.opts) { fillFilterBars(); rerender(); }
});

/* ---------------- Live data ----------------
   The source table is rebuilt as a snapshot (GeneratedDate). The server notices a new snapshot within a minute;
   this poll then offers a one-click reload so figures change without losing the current screen or filters. */
const POLL_MS = 120000;
async function checkForNewData() {
  if (document.hidden || !D.meta) return;
  try {
    const { snapshot } = await api.version();
    if (snapshot && snapshot !== D.meta.snapshot) {
      const when = new Date(snapshot).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      $('#newDataText').textContent = `New data is available — the payments snapshot was refreshed on ${when}.`;
      $('#newData').hidden = false;
    }
  } catch (e) { /* offline or server restarting: try again next tick */ }
}
$('#newDataBtn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  await loadFy(S.fy); $('#newData').hidden = true; rerender(); verifyLive(); toast('Figures updated to the latest snapshot');
}));
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNewData(); });

/* ---------------- Live database ---------------- */
$('#liveBadge').addEventListener('click', verifyLive);
$('#commDetailClose').addEventListener('click', () => { $('#commDetail').hidden = true; });
window.addEventListener('mcb:db-down', (e) => markDown(e.detail));

/* ---------------- Boot ---------------- */
restoreFilters();
bindFilterBars(onFilterChange);
applyThemeIcon();
resetSuggestions('portfolio');
window.addEventListener('popstate', route);
loadFy(null)
  .then(() => { route(); verifyLive(); paintAiStatus(); setInterval(checkForNewData, POLL_MS); })
  .catch((err) => { markDown(err); showLoadError(err); });
