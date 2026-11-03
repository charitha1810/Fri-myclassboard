/* Institute scoring: the single source of truth for status, loan fit, score and next play. */
import { sum, esc } from './format.js';
import { T } from './lang.js';

export const LOAN_FIT_RS = 35000;   // collections per student in the window that make a loan / EMI partner worth pitching

/* How much of an institute's fees came online through the MCB gateway (label, chip tone). */
export const STATUS = { live: ['Pays online well (10%+)', 'green'], low: ['Few online payments (under 10%)', 'amber'], nopg: ['No online payments', 'orange'], dormant: ['No recent collections', 'gray'] };
/* Plays keep their stored keys (pipeline deals use them); users see the plain label. */
export const PLAY = { 'Activate PG': 'orange', 'Drive adoption': 'amber', 'Re-engage': 'gray', 'Add loan partner': 'blue', 'Protect & grow': 'violet' };
export const PLAY_LABEL = { 'Activate PG': 'Sell MCB gateway', 'Drive adoption': 'Get more parents paying online', 'Re-engage': 'Call: collections stopped', 'Add loan partner': 'Offer loan / EMI partner', 'Protect & grow': 'Doing well: keep growing' };
export const PLAY_HELP = {
  'Activate PG': 'Almost nothing is paid online through MCB. Pitch the MCB gateway.',
  'Drive adoption': 'Has the gateway, but under 10% of fees are paid online. Push pay links and a counter QR.',
  'Re-engage': 'No fees recorded in the last two months. Find out why.',
  'Add loan partner': 'High fees per student. Offer an education loan or EMI partner.',
  'Protect & grow': 'Already pays well online. Keep it that way.'
};
// Simple wording shows the plain label; Advanced shows the stored key (Activate PG, Convertible…).
export const playChip = (p) => `<span class="chip chip-${PLAY[p] || 'gray'}" title="${PLAY_HELP[p] || ''}">${T(esc(PLAY_LABEL[p] || p), esc(p))}</span>`;
export const roleChip = (r) => `<span class="chip chip-${ROLE[r] || 'gray'}" title="${esc(ROLE_HELP[r] || '')}">${T(esc(ROLE_LABEL[r] || r), esc(r))}</span>`;
export const ROLE = { Earns: 'violet', Convertible: 'orange', 'Outside MCB PG': 'lilac', Mandate: 'blue', Other: 'gray' };
export const ROLE_LABEL = { Earns: 'We earn on this', Convertible: 'Offline: can move online', 'Outside MCB PG': 'Online, but not via MCB', Mandate: 'Auto-debit', Other: 'Other' };
export const ROLE_HELP = {
  Earns: 'Paid through the MCB gateway: MCB earns commission on it',
  Convertible: 'Paid at the counter (cash, card swipe, cheque, DD): could be moved to MCB pay links',
  'Outside MCB PG': 'Paid online, but straight to the school\'s bank (NEFT, direct UPI, BBPS): MCB earns nothing',
  Mandate: 'Automatic bank debit (ECS / NACH)',
  Other: 'Other payment types'
};

/**
 * @param inst   institute from /api/institutes (months = [[gatewayRs, otherModesRs], ...], offline_months = [offlineRs, ...])
 * @param rates  { take, conv } as fractions
 * @param nMonths months in the window, used to annualise
 */
export function metrics(inst, rates, nMonths) {
  const pg = sum(inst.months.map((m) => m[0]));
  const other = sum(inst.months.map((m) => m[1]));          // every payment mode except the MCB gateway
  // Offline = cash, card swipe, cheque and DD only. Bank transfers, auto-debit, loans and scholarships are in
  // `other` but are not counter payments, so they are not money a pay link could move online.
  const offM = inst.offline_months || inst.months.map((m) => m[1]);
  const off = sum(offM);
  const tot = pg + other;
  const share = tot ? pg / tot : 0;
  const last2 = inst.months.slice(-2).reduce((a, m) => a + m[0] + m[1], 0);
  let status;
  if (last2 === 0) status = 'dormant';
  else if (pg <= 2 * inst.months.length) status = 'nopg';   // ₹0–1 test payments only
  else if (share < 0.10) status = 'low';
  else status = 'live';
  const perStu = inst.students ? tot / inst.students : 0;
  const loanFit = perStu >= LOAN_FIT_RS;
  const vol = Math.min(1, Math.log10(Math.max(off, 1)) / Math.log10(2e8));
  const score = Math.round(100 * (0.45 * vol + 0.30 * (1 - share) + 0.15 * (status === 'nopg' || status === 'low' ? 1 : 0) + 0.10 * (loanFit ? 1 : 0)));
  let play = 'Protect & grow';
  if (status === 'nopg') play = 'Activate PG';
  else if (status === 'low') play = 'Drive adoption';
  else if (status === 'dormant') play = 'Re-engage';
  else if (loanFit) play = 'Add loan partner';
  const last = inst.months[inst.months.length - 1] || [0, 0];
  const annualise = nMonths ? 12 / nMonths : 0;
  return {
    pg, off, other, tot, share, status, perStu, loanFit, score, play,
    annualise,
    revYr: off * annualise * rates.conv * rates.take,
    lastPg: last[0], lastOff: offM[offM.length - 1] || 0, lastTot: last[0] + last[1],
    lastShare: (last[0] + last[1]) ? last[0] / (last[0] + last[1]) : 0
  };
}

export const consentState = (x) => {
  const v = Object.values(x.consent);
  if (v.includes('y')) return 'granted';
  if (v.includes('p')) return 'pending';
  return 'none';
};
export const locked = (x) => Object.values(x.consent).every((v) => v !== 'y');
