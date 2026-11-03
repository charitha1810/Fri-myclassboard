/* Partner segments and payment-mode groups shared by Command Center, Institutes and Gateways. */
import { pal, inkOn } from './chart.js';
import { T, pick } from './lang.js';
import { esc } from './format.js';

/** key, label, short label, chip tone, palette key */
export const SEGMENTS = [
  ['partner', 'Uses our partner gateway', 'Our partner gateway', 'violet', 'pg'],
  ['non_partner', 'Uses a gateway that is not our partner', 'Not our partner', 'blue', 'neft'],
  ['no_active', 'Gateway set up but not in use', 'Gateway not in use', 'amber', 'card'],
  ['na', "Doesn't use any MCB gateway", 'No MCB gateway', 'orange', 'cash'],
  ['unmapped', 'No gateway information', 'No gateway info', 'gray', 'oth'],
  ['unknown', 'Gateway details not available', 'Not available', 'gray', 'oth']
];
/** Advanced wording: [label, short] in analyst / database terms. */
const SEG_ADV = {
  partner: ['MCB partner PG (IsActive 1 · IsMCBPartner 1)', 'Partner PG'],
  non_partner: ['Non-partner PG (IsActive 1 · IsMCBPartner 0)', 'Non-partner PG'],
  no_active: ['Mapped, no active PG', 'No active PG'],
  na: ['N/A: not on MCB PG', 'N/A'],
  unmapped: ['Unmapped', 'Unmapped'],
  unknown: ['Mapping unreadable', 'Unreadable']
};
export const SEG = Object.fromEntries(SEGMENTS.map((s) => [s[0], { key: s[0], label: s[1], short: s[2], tone: s[3], color: () => pal()[s[4]], adv: SEG_ADV[s[0]] }]));
/** Segment name in both wordings (HTML). */
export const segName = (k, short = false) => {
  const s = SEG[k];
  return s ? T(esc(short ? s.short : s.label), esc(s.adv[short ? 1 : 0])) : '';
};
export const SEG_HELP = {
  partner: 'Parents can pay online through a gateway that is our partner, so MCB earns commission on those payments',
  non_partner: 'Parents pay online through a gateway that is not our partner, so MCB earns nothing on them',
  no_active: 'A gateway is set up, but it is not currently in use or is not in our gateway list',
  na: 'This school does not use any MCB payment gateway; all fees are collected outside MCB',
  unmapped: 'We have no gateway information for this school',
  unknown: 'Gateway details for this school could not be read'
};

/** Branch status (from the gateway mapping): key, label, palette key */
export const BRANCH_STATUS = [
  ['partner', 'Branch uses our partner gateway', 'pg'],
  ['non_partner', 'Branch uses another gateway', 'neft'],
  ['na', 'Branch has no MCB gateway', 'cash'],
  ['none', 'No gateway information', 'oth']
];
/** Branch coverage per institute: key, label, short, chip tone, palette key */
export const COVERAGE = [
  ['all', 'Every branch uses an MCB gateway', 'All branches', 'green', 'pg'],
  ['partial', "Some branches don't use an MCB gateway", 'Some branches', 'amber', 'card'],
  ['none', 'No branch uses an MCB gateway', 'No branches', 'orange', 'cash'],
  ['unmapped', 'No branch information', 'No branch info', 'gray', 'oth']
];
export const COV = Object.fromEntries(COVERAGE.map((c) => [c[0], { key: c[0], label: c[1], short: c[2], tone: c[3], color: () => pal()[c[4]] }]));

export const branchesOn = (mix) => (mix.partner || 0) + (mix.non_partner || 0);
export const branchesTotal = (mix) => Object.values(mix || {}).reduce((a, b) => a + b, 0);

/** "8 of 10 on gateway" + a thin bar split by branch status. */
export function branchCell(x) {
  const mix = x.branch_mix || {}, tot = branchesTotal(mix);
  if (!tot) return '<span class="fs-8 text-faint">Not mapped</span>';
  const P = pal();
  const bar = BRANCH_STATUS.map(([k, l, c]) => mix[k] ? `<div style="width:${(100 * mix[k] / tot).toFixed(2)}%;background:${P[c]}" title="${l}: ${mix[k]}"></div>` : '').join('');
  const on = branchesOn(mix);
  const parts = [mix.partner ? `${mix.partner} on our partner` : '', mix.non_partner ? `${mix.non_partner} on other gateways` : '', mix.na ? `<span class="text-orange">${mix.na} with no MCB gateway</span>` : ''].filter(Boolean).join(' · ');
  return `<div class="d-flex justify-content-between fs-8"><b>${on} of ${tot} branches use an MCB gateway</b></div><div class="mini-split my-1" style="height:7px">${bar}</div><div class="fs-8 text-muted-2">${parts}</div>`;
}
export const branchLegend = () => {
  const P = pal();
  return BRANCH_STATUS.slice(0, 3).map(([, l, c]) => `<span><i class="sw" style="background:${P[c]}"></i>${l}</span>`).join('');
};

/** Which payment gateway(s) an institute uses, with branch counts; when there are several gateways or branches,
 *  a "Show branches" list grouped by gateway (which branch is on which gateway). */
/* Plain-language name and tag for each kind of branch gateway. */
const BG = {
  partner: { tone: 'pg', tag: 'our partner' },
  non_partner: { tone: 'neft', tag: 'not our partner' },
  unknown: { tone: 'card', tag: 'not in gateway list' },
  na: { tone: 'cash', name: 'No MCB gateway' },
  none: { tone: 'oth', name: 'No gateway set' }
};
const gwName = (g) => (BG[g.kind] && BG[g.kind].name) || g.gateway;
const gwTag = (g) => (BG[g.kind] && BG[g.kind].tag) ? ` <span class="text-muted-2">(${BG[g.kind].tag})</span>` : '';
const dot = (g) => `<i class="sw" style="background:${pal()[(BG[g.kind] || BG.none).tone]}"></i>`;
/** A branch-gateway group's display name, short tag, colour and chip tone (for the branch pop-up). */
export const gwLabel = (g) => ({ name: gwName(g), tag: (BG[g.kind] && BG[g.kind].tag) || '', color: pal()[(BG[g.kind] || BG.none).tone],
  tone: { partner: 'violet', non_partner: 'blue', unknown: 'amber' }[g.kind] || 'gray' });

export function gatewayUsage(x) {
  const groups = (x.branch_gateways || []).filter((g) => g.kind !== 'inactive');   // inactive gateways are not shown
  if (!groups.length) {
    return `<div class="fs-8 text-faint mt-1">${x.gateway_status === 'unknown' ? 'Gateway details not available' : 'No gateway information'}</div>`;
  }
  const br = (n) => `${n} branch${n === 1 ? '' : 'es'}`;
  // One line: "● Razorpay (not our partner) — 2 branches · ● No MCB gateway — 1 branch"
  const line = groups.map((g) => `<span class="gw-item">${dot(g)}<b>${esc(gwName(g))}</b>${gwTag(g)}${x.branches > 1 ? ` — ${br(g.branches.length)}` : ''}</span>`).join('<span class="gw-sep">·</span>');
  if (groups.length < 2) return `<div class="gw-line">${line}</div>`;
  // Several gateways: a button opens the "which branch uses which gateway" pop-up (one block per gateway).
  return `<div class="gw-line">${line}</div>
    <button type="button" class="btn btn-link btn-sm p-0 gw-branches-btn" data-branch-popup="${esc(x.id)}">▸ See which branch uses which gateway</button>`;
}
/** Gateway status from MasterPaymentGateways: key, label, chip tone */
export const GW_KIND = {
  partner: ['Our partner (we earn)', 'violet'],
  non_partner: ['Not our partner', 'blue'],
  unknown: ['Not in our gateway list', 'amber']
};
const GW_KIND_ADV = { partner: 'IsMCBPartner 1', non_partner: 'IsMCBPartner 0', unknown: 'Not in MasterPaymentGateways' };
export const gwKindChip = (k) => GW_KIND[k] ? `<span class="chip chip-${GW_KIND[k][1]}">${T(GW_KIND[k][0], GW_KIND_ADV[k])}</span>` : '';

/** Payment-mode groups for mixes: [key, label, palette key, mode keys | null for "everything else"] */
export const MODE_GROUPS = [
  ['pg', 'Online via MCB gateway', 'pg', ['pg']],
  ['neft', 'Bank transfer / direct UPI', 'neft', ['neft', 'upi', 'bbps']],
  ['cash', 'Cash', 'cash', ['cash']],
  ['card', 'Card swipe', 'card', ['card']],
  ['chq', 'Cheque & DD', 'chq', ['cheque', 'dd']],
  ['ecs', 'Auto-debit (ECS)', 'ecs', ['ecs']],
  ['loan', 'Education loan', 'ln', ['loan']],
  ['oth', 'Other', 'oth', null]
];
/** What "Other" holds: every payment mode in the database that has no group of its own. */
export const OTHER_HELP = 'Challan, scholarship, salary deductions, refunds / transfers, credit notes, prepaid card and any unmapped mode';
/** The groups that are offline counter payments (could move to pay links). */
export const OFFLINE_GROUPS = ['cash', 'card', 'chq'];
const GROUPED = new Set(MODE_GROUPS.flatMap((g) => g[3] || []));
const GROUP_ADV = { pg: 'MCB PG', neft: 'NEFT / UPI / BBPS', cash: 'Cash', card: 'POS', chq: 'Cheque & DD', ecs: 'ECS / NACH', loan: 'Loan Payments', oth: 'Other' };
/** Payment-group name in both wordings (HTML). */
export const groupName = (k) => T(esc((MODE_GROUPS.find((g) => g[0] === k) || [, k])[1]), esc(GROUP_ADV[k] || k));
/** Palette key for a single payment mode key (pg, cash, upi…). */
export const modeColorKey = (key) => (MODE_GROUPS.find((g) => g[3] && g[3].includes(key)) || MODE_GROUPS[MODE_GROUPS.length - 1])[2];

/** Collapse a {modeKey: amount} map into the MODE_GROUPS order. */
export function groupModes(byMode) {
  const out = Object.fromEntries(MODE_GROUPS.map((g) => [g[0], 0]));
  for (const [k, v] of Object.entries(byMode || {})) {
    const g = MODE_GROUPS.find((x) => x[3] && x[3].includes(k));
    out[g ? g[0] : 'oth'] += v;
  }
  return out;
}
export const isGrouped = (k) => GROUPED.has(k);

/**
 * Horizontal stacked bar with the numbers printed on it.
 * parts: [{ label, value, color, text? }] — text defaults to "label · %"; segments too narrow for text
 * still show their % when there is room, and every part is repeated in the key underneath.
 */
export function labeledBar(parts, { height = 28, unit = '' } = {}) {
  const list = parts.filter((p) => p.value > 0);
  const tot = list.reduce((a, p) => a + p.value, 0);
  if (!tot) return '<div class="fs-8 text-faint">No data</div>';
  const pc = (v) => 100 * v / tot;
  const fmtPct = (v) => (pc(v) < 1 ? '<1' : Math.round(pc(v))) + '%';
  const segs = list.map((p) => {
    const w = pc(p.value);
    const full = p.text || `${p.label} · ${fmtPct(p.value)}`;
    const inner = w >= 18 ? full : w >= 5 ? fmtPct(p.value) : '';
    const act = p.list ? ` data-list-popup="${esc(p.list)}"` : p.rank ? ` data-rank="${esc(p.rank)}"` : '';
    const click = act ? `${act} role="button" tabindex="0" style="cursor:pointer;` : ' style="';
    return `<div${click}flex:${p.value};background:${p.color};color:${inkOn(p.color)}" title="${esc(p.label)}: ${esc(p.tip || fmtPct(p.value))}${p.list ? ' · click to list these schools' : p.rank ? ' · click for the top and bottom 10%' : ''}">${esc(inner)}</div>`;
  }).join('');
  const key = list.map((p) => {
    const sw = p.rank ? `<button type="button" class="sw-btn" data-rank="${esc(p.rank)}" title="Top and bottom 10% of schools" aria-label="Top and bottom 10% of schools: ${esc(p.label)}"><i class="sw" style="background:${p.color}"></i></button>`
      : `<i class="sw" style="background:${p.color}"></i>`;
    const label = `${esc(p.label)}: <b>${esc(p.keyText || fmtPct(p.value))}</b>${unit}`;
    return p.list ? `<span class="d-inline-flex align-items-center gap-1">${sw}<button type="button" class="legend-btn" data-list-popup="${esc(p.list)}" title="Click to list these schools">${label}</button></span>`
      : `<span>${sw}${label}</span>`;
  }).join('');
  return `<div class="lbar" style="height:${height}px" role="img" aria-label="${esc(list.map((p) => p.label + ' ' + fmtPct(p.value)).join(', '))}">${segs}</div><div class="legend lbar-key">${key}</div>`;
}

/** Top payment methods of a grouped mix as words: "Online via MCB gateway 37% · Cash 30% · Cheque & DD 14%". */
export function mixText(grouped, n = 3) {
  const tot = Object.values(grouped).reduce((a, b) => a + b, 0);
  if (!tot) return '';
  return MODE_GROUPS.map((g) => [g[1], grouped[g[0]] || 0]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([l, v]) => `${pick(l.replace('Online via MCB gateway', 'Online (MCB)').replace('Bank transfer / direct UPI', 'Bank transfer'), GROUP_ADV[(MODE_GROUPS.find((g) => g[1] === l) || [])[0]] || l)} ${Math.round(100 * v / tot) || '<1'}%`).join(' · ');
}

/** Thin stacked bar of a grouped mix. */
export function mixBar(grouped, height = 10, words = true) {
  const P = pal();
  const tot = Object.values(grouped).reduce((a, b) => a + b, 0);
  if (!tot) return `<div class="mini-split" style="height:${height}px"></div>`;
  return `<div class="mini-split" style="height:${height}px">${MODE_GROUPS.map((g) => grouped[g[0]] > 0
    ? `<div style="width:${(100 * grouped[g[0]] / tot).toFixed(2)}%;background:${P[g[2]]}" title="${g[1]}: ${(100 * grouped[g[0]] / tot).toFixed(1)}%"></div>` : '').join('')}</div>`
    + (words ? `<div class="fs-8 text-muted-2 mt-1 mix-words">${esc(mixText(grouped))}</div>` : '');
}
/** Colour key for the payment-mode groups. `clickable` makes each entry open the top / bottom 10 schools pop-up. */
export const mixLegend = (clickable = false) => {
  const P = pal();
  return MODE_GROUPS.map((g) => clickable
    ? `<button type="button" class="legend-btn" data-rank="mode:${g[0]}" title="Show the top and bottom 10% of schools for this"><i class="sw" style="background:${P[g[2]]}"></i>${groupName(g[0])}</button>`
    : `<span><i class="sw" style="background:${P[g[2]]}"></i>${groupName(g[0])}</span>`).join('');
};
