/* Loaded API data (D) and UI state (S). Views read from here; app.js fills it. */
import { metrics } from './metrics.js';

/** API payloads for the selected FY: meta, settings, modes, gw, loans, inst, opts, alerts, pipe */
export const D = {};

// Institutes-page filters (the global ones live in S.gf).
export const FILTER_DEFAULTS = { view: 'all', q: '' };

// Global filters: sent to every analytics endpoint. Empty string = no filter.
// `rate` is the commission rate in bps chosen in the bar ('' = the saved rate from Revenue settings).
export const GF_DEFAULTS = { from: '', to: '', db: '', partner: '', coverage: '', gw_kind: '', gateway: '', modes: '', inst: '', rate: '' };
export const RATE_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200];
export const gfActive = () => Object.keys(GF_DEFAULTS).filter((k) => S.gf[k]);
export const gfParams = () => ({ fy: S.fy, ...S.gf });

export const S = {
  fy: null,
  // Per-section filters (filters.js); S.gf points at the active section's object.
  vf: {},
  gf: { from: '', to: '', db: '', partner: '', coverage: '', gw_kind: '', gateway: '', modes: '', inst: '', rate: '' },
  period: 'fytd', shift: 20,
  ...FILTER_DEFAULTS, sort: 'score', sortDir: -1, sel: new Set(), page: 1,
  instId: null, conv360: 30, notes: {},
  gwSort: 'vol', gwSeg: 'all',
  camp: { scope: 'selected', sel: new Set(), ch: { app: true, wa: true, sms: false }, pv: 'wa', cad: { t7: true, t3: true, t1: true, d0: true, p3: true, p7: false } },
  play: 'all'
};

/** Commission rate in bps: the one picked in the filter bar, else the saved default. */
export const rateBps = () => Number(S.gf.rate) || (D.settings?.take_bps ?? 30);
export const rates = () => ({
  take: rateBps() / 10000,
  loan: (D.settings?.loan_fee_pct ?? 1) / 100,
  conv: (D.settings?.conv_pct ?? 30) / 100
});

/* Institutes enriched with metrics; recomputed only when data or settings change. */
let cache = null;
export const invalidate = () => { cache = null; };
export function INST() {
  if (!cache) {
    const r = rates(), n = D.inst.months.length;
    cache = D.inst.institutes.map((i) => Object.assign({}, i, metrics(i, r, n)));
  }
  return cache;
}
export const instById = (id) => INST().find((x) => x.id === id);
export const rawInst = (id) => D.inst.institutes.find((x) => x.id === id);
export const GW_STATUS_LABEL = { na: 'No MCB gateway', unmapped: 'No gateway mapping', unknown: 'Mapping not readable' };
export const gatewayLabel = (x) => x.gateways.length
  ? x.gateways.join(', ') + (x.na_branches ? ` · ${x.na_branches} branch${x.na_branches > 1 ? 'es' : ''} N/A` : '')
  : GW_STATUS_LABEL[x.gateway_status];
export const ownerName = (id) => (D.meta.owners.find((o) => o.id === id) || {}).name || id;

/* Index helpers for the payment-mode months (last = latest month in the extract). */
export const L = () => D.modes.months.length - 1;
export const lastMon = () => D.modes.months[L()];
export const prevMon = () => D.modes.months[L() - 1];
