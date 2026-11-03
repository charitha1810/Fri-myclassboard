/* Section filters: each section has its own filter bar, its own state and its own data.
   S.vf[view] holds a section's filters; S.gf points at the active section's object so the rest of the
   code (gfParams, rates, AI requests) always uses the filters of the section on screen. */
import { D, S, GF_DEFAULTS, RATE_OPTIONS } from './store.js';
import { esc, nf } from './format.js';
import { $$ } from './ui.js';
import { pick } from './lang.js';

const KEY = 'mcb-section-filters';

/** Which filters each section offers, in display order. */
export const VIEW_FILTERS = {
  command: ['inst', 'partner', 'coverage', 'modes', 'rate'],
  institutes: ['inst', 'partner', 'coverage', 'gw_kind', 'gateway', 'modes', 'rate'],
  coverage: ['inst', 'partner', 'coverage', 'gw_kind', 'gateway'],
  loans: ['inst', 'partner', 'coverage', 'gw_kind', 'gateway'],
  institute: ['modes', 'rate']
};
const LABEL = { from: 'From month', to: 'To month', db: 'Database', inst: 'School', partner: 'Which gateway the school uses', coverage: 'Branches with MCB gateway',
  gw_kind: 'Gateway partner?', gateway: 'Gateway name', modes: 'Payment method', rate: 'MCB commission rate' };
const LABEL_ADV = { inst: 'Organisation', partner: 'Partner segment', coverage: 'Branch coverage', gw_kind: 'PG status (IsMCBPartner)',
  gateway: 'PaymentGatewayName', modes: 'PaymentModeID', rate: 'Take rate' };
const lbl = (k) => pick(LABEL[k], LABEL_ADV[k]);
const HELP = { from: 'First month to count. "First month" = the start of the financial year.', to: 'Last month to count. "Latest month" = the latest complete month.', partner: 'Partner PG = our partner gateway · Non partner PG = another gateway · No PG = no gateway in use · Mostly cash usage = cash is the school\'s biggest payment method', coverage: 'Do all, some or none of the school\'s branches use an MCB gateway?',
  gw_kind: 'Show schools that use a gateway that is / is not our partner', gateway: 'Show schools that use this gateway', modes: 'Count only these payment methods (cash, online, cheque…)',
  rate: 'What % of online fees through our partner gateways MCB earns. Used for every commission figure.' };

export const viewFilters = (view) => (S.vf[view] ||= { ...GF_DEFAULTS });
/** Make `view` the active section: S.gf now refers to its filters. */
export function activate(view) { S.gf = viewFilters(view); }
export const activeCount = (view) => (VIEW_FILTERS[view] || []).filter((k) => viewFilters(view)[k]).length;

function persist() { try { localStorage.setItem(KEY, JSON.stringify(S.vf)); } catch (e) {} }

/** Saved section filters; filters in the page URL (?partner=na#institutes) apply to the section in the link. */
export function restoreFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const v of Object.keys(VIEW_FILTERS)) S.vf[v] = { ...GF_DEFAULTS, ...(saved[v] || {}) };
  } catch (e) { for (const v of Object.keys(VIEW_FILTERS)) S.vf[v] = { ...GF_DEFAULTS }; }
  try {
    const qs = new URLSearchParams(location.search);
    const view = (location.hash.slice(1).split('/')[0] || 'command');
    if (VIEW_FILTERS[view] && [...qs.keys()].some((k) => k in GF_DEFAULTS)) {
      S.vf[view] = { ...GF_DEFAULTS };
      for (const k of Object.keys(GF_DEFAULTS)) if (qs.get(k)) S.vf[view][k] = qs.get(k);
      persist();
    }
  } catch (e) {}
}

/** Drop saved values the current FY does not offer (a month or database with no data). */
export function validateFilters() {
  const O = D.opts;
  const ok = {
    from: O.months, to: O.months, db: O.dbs.map((o) => o.value), partner: (O.partners || []).map((o) => o.value),
    coverage: (O.coverage || []).map((o) => o.value), gateway: O.gateways.map((o) => o.value),
    gw_kind: (O.gw_kinds || []).map((o) => o.value), rate: RATE_OPTIONS.map(String), inst: (O.institutes || []).map((o) => o.value)
  };
  const modes = new Set((O.modes || []).map((o) => o.value));
  for (const [view, f] of Object.entries(S.vf)) {
    for (const k of Object.keys(ok)) if (f[k] && !ok[k].includes(f[k])) f[k] = '';
    // A filter the section does not offer must not keep narrowing its data.
    for (const k of Object.keys(GF_DEFAULTS)) if (!(VIEW_FILTERS[view] || []).includes(k)) f[k] = '';
    if (f.modes) f.modes = f.modes.split(',').filter((m) => modes.has(m)).join(',');
  }
  persist();
}

// ---------------- rendering ----------------
const opt = (v, l, n) => `<option value="${esc(v)}">${esc(l)}${n ? ' (' + nf(n) + ')' : ''}</option>`;
const pctTxt = (b) => (b / 100).toFixed(2) + '%';

function control(view, key) {
  const O = D.opts, id = `vf-${view}-${key}`;
  const sel = (inner, title = HELP[key] || '') => `<div class="gf-item"><label for="${id}" class="form-label">${lbl(key)}</label><select id="${id}" class="form-select form-select-sm" data-f="${key}"${title ? ` title="${esc(title)}"` : ''}>${inner}</select></div>`;
  switch (key) {
    case 'from': return sel(opt('', 'First month') + O.months.map((m) => opt(m, m)).join(''));
    case 'to': return sel(opt('', 'Latest month') + O.months.map((m) => opt(m, m)).join(''));
    case 'db': return sel(opt('', 'All databases') + O.dbs.map((o) => opt(o.value, o.label, o.count)).join(''));
    case 'inst':   // type-to-search over every school (shared <datalist id="schoolList">)
      return `<div class="gf-item gf-school"><label for="${id}" class="form-label">${lbl('inst')}</label>
        <input id="${id}" class="form-control form-control-sm" list="schoolList" placeholder="All schools — type to search" autocomplete="off" data-f-school></div>`;
    case 'partner': return sel(opt('', 'All') + (O.partners || []).map((o) => opt(o.value, o.label, o.count)).join(''));
    case 'coverage': return sel(opt('', 'All') + (O.coverage || []).map((o) => opt(o.value, o.label, o.count)).join(''));
    case 'gateway': return sel(opt('', 'All gateways') + O.gateways.map((o) => opt(o.value, o.label, o.count)).join(''));
    case 'gw_kind': return sel(opt('', 'All') + (O.gw_kinds || []).map((o) => `<option value="${esc(o.value)}" ${o.count ? '' : 'disabled'}>${esc(o.label)} (${nf(o.count)})</option>`).join(''));
    case 'rate': {
      const saved = D.settings?.take_bps ?? 30;
      return sel(opt('', `Default · ${pctTxt(saved)}`) + RATE_OPTIONS.map((b) => `<option value="${b}">${pctTxt(b)}</option>`).join(''));
    }
    case 'modes':
      return `<div class="gf-item dropdown" title="${esc(HELP.modes)}"><span class="form-label d-block" id="${id}-lbl">${lbl('modes')}</span>
        <button class="form-select form-select-sm text-start text-truncate" type="button" data-fm-btn data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false" aria-labelledby="${id}-lbl">All modes</button>
        <div class="dropdown-menu p-2" style="min-width:260px;max-height:360px;overflow:auto" data-fm-menu>
          <div class="d-flex justify-content-between align-items-center px-1 pb-2 mb-1 border-bottom fs-8"><b>Payment modes</b><button type="button" class="btn btn-link btn-sm p-0" style="min-height:0" data-fm-all>All modes</button></div>
          ${(O.modes || []).map((o) => `<div class="form-check py-1"><input class="form-check-input" type="checkbox" id="${id}-${esc(o.value)}" value="${esc(o.value)}" ${o.count ? '' : 'disabled'}>
            <label class="form-check-label d-flex justify-content-between gap-3 w-100 fs-7 ${o.count ? '' : 'text-faint'}" for="${id}-${esc(o.value)}"><span>${esc(o.label)}</span><span class="text-muted-2">${o.count ? nf(o.count) : 'unused'}</span></label></div>`).join('')}
        </div></div>`;
    default: return '';
  }
}

/** Build every section's filter bar from /api/filter-options (after each FY load). */
export function fillFilterBars() {
  $$('.vfbar[data-vf]').forEach((bar) => {
    const view = bar.dataset.vf;
    bar.innerHTML = `<div class="d-flex flex-wrap align-items-end gap-2">${VIEW_FILTERS[view].map((k) => control(view, k)).join('')}
      <div class="d-flex align-items-center gap-2 ms-auto"><span class="fs-8 text-muted-2" data-f-summary aria-live="polite"></span>
      <button type="button" class="btn btn-sm btn-quiet" data-f-clear hidden>Clear filters</button></div></div>`;
    syncBar(view);
  });
}

export function syncBar(view) {
  const bar = document.querySelector(`.vfbar[data-vf="${view}"]`);
  if (!bar) return;
  const f = viewFilters(view);
  bar.querySelectorAll('select[data-f]').forEach((s) => { s.value = f[s.dataset.f] || ''; s.classList.toggle('gf-on', !!f[s.dataset.f]); });
  const school = bar.querySelector('[data-f-school]');
  if (school) {
    const hit = (D.opts.institutes || []).find((o) => o.value === f.inst);
    if (document.activeElement !== school) school.value = hit ? hit.label : '';
    school.classList.toggle('gf-on', !!f.inst);
  }
  const picked = f.modes ? f.modes.split(',') : [];
  bar.querySelectorAll('[data-fm-menu] input[type=checkbox]').forEach((c) => { c.checked = picked.includes(c.value); });
  const btn = bar.querySelector('[data-fm-btn]');
  if (btn) {
    const names = (D.opts.modes || []).filter((o) => picked.includes(o.value)).map((o) => o.label);
    btn.textContent = !picked.length ? 'All modes' : picked.length === 1 ? names[0] : `${picked.length} modes`;
    btn.title = names.join(', ');
    btn.classList.toggle('gf-on', picked.length > 0);
  }
  const n = activeCount(view);
  bar.querySelector('[data-f-clear]').hidden = !n;
  const showing = S.gf === f && D.inst && D.modes;
  bar.querySelector('[data-f-summary]').textContent = !showing ? '' : view === 'institute'
    ? (n ? `${n} filter${n > 1 ? 's' : ''} · ${D.modes.months.length ? D.modes.months[0] + '–' + D.modes.months.at(-1) : 'no months'}` : 'Full FY · all payment modes')
    : (n ? `${n} filter${n > 1 ? 's' : ''} · ${nf(D.inst.institutes.length)} institute${D.inst.institutes.length === 1 ? '' : 's'} · ${D.modes.months.length ? D.modes.months[0] + '–' + D.modes.months.at(-1) : 'no months'}`
      : `All ${nf(D.inst.institutes.length)} institutes · full FY`);
}

const AUTO_PG = new Map();   // view -> gateway-filter value that picking a school filled in

/** School box: an exact pick from the list (or a unique partial match) filters to that school; empty = all schools. */
function pickSchool(input, view, f, apply) {
  const t = input.value.trim().toLowerCase();
  const list = D.opts.institutes || [];
  let hit = null;
  if (t) {
    hit = list.find((o) => o.label.toLowerCase() === t);
    if (!hit) { const m = list.filter((o) => o.label.toLowerCase().includes(t)); if (m.length === 1) hit = m[0]; }
    if (!hit) { input.classList.add('is-invalid'); input.title = 'Pick a school from the list'; return; }
  }
  input.classList.remove('is-invalid'); input.title = '';
  const next = hit ? hit.value : '';
  if (next === f.inst) { syncBar(view); return; }
  f.inst = next;
  // Picking a school also sets "Which gateway the school uses" to that school's own value; clearing the school undoes it.
  if (VIEW_FILTERS[view].includes('partner')) {
    if (hit && hit.pg) { f.partner = hit.pg; AUTO_PG.set(view, hit.pg); }
    else if (!hit && f.partner === AUTO_PG.get(view)) { f.partner = ''; AUTO_PG.delete(view); }
  }
  apply(view);
}

/** Wire every bar. `onChange(view)` reloads that section's data and redraws it. */
export function bindFilterBars(onChange) {
  const apply = (view) => { persist(); syncBar(view); onChange(view); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('.vfbar [data-f-school]')) return;
    e.preventDefault();
    const view = e.target.closest('.vfbar').dataset.vf;
    pickSchool(e.target, view, viewFilters(view), apply);
  });
  document.addEventListener('change', (e) => {
    const bar = e.target.closest('.vfbar[data-vf]');
    if (!bar) return;
    const view = bar.dataset.vf, f = viewFilters(view);
    if (e.target.matches('select[data-f]')) { f[e.target.dataset.f] = e.target.value; apply(view); }
    if (e.target.matches('[data-f-school]')) pickSchool(e.target, view, f, apply);
    if (e.target.closest('[data-fm-menu]')) {   // several modes can be ticked: one reload after a short pause
      f.modes = [...bar.querySelectorAll('[data-fm-menu] input:checked')].map((c) => c.value).join(',');
      syncBar(view);
      clearTimeout(bar._t); bar._t = setTimeout(() => apply(view), 450);
    }
  });
  document.addEventListener('click', (e) => {
    const bar = e.target.closest('.vfbar[data-vf]');
    const view = bar ? bar.dataset.vf : e.target.closest('[data-f-clear-view]')?.dataset.fClearView;
    if (!view) return;
    if (e.target.closest('[data-fm-all]')) { viewFilters(view).modes = ''; clearTimeout(bar._t); apply(view); }
    if (e.target.closest('[data-f-clear]')) { Object.assign(viewFilters(view), GF_DEFAULTS); apply(view); }
  });
}

/** Replace one section's filters (e.g. a segment tile that opens Institutes pre-filtered). */
export function presetFilters(view, values) {
  Object.assign(viewFilters(view), GF_DEFAULTS, values);
  persist();
}
