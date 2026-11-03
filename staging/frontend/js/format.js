/* Number, money and text helpers (Indian digit grouping). Money is always shown in full, to the paisa: no Cr / L / k rounding. */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nf = (v, d = 0) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
export const rupees = (r) => '₹' + nf(r || 0, 2);                                     // the exact amount: ₹1,02,28,45,75,161.12
export const cr = (v) => rupees((v || 0) * 1e7);                                      // value in crore (the server keeps 9 decimals = exact to the paisa)
export const money = cr;
export const rs = rupees;                                                             // value in rupees
export const crAxis = (v) => '₹' + nf(v, v % 1 ? 1 : 0) + ' Cr';                      // chart scale marks only (round by construction)
export const lakh = (n) => nf(n);                                                     // counts in full: 14,04,207
export const pct = (v, d = 1) => nf(v, d) + '%';
export const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
export const growth = (a, b) => (b ? (a / b - 1) * 100 : null);

const FULL = { Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December' };
export const fullMonth = (m) => FULL[m] || m;
export const range = (months) => months.length ? (months.length === 1 ? months[0] : months[0] + '–' + months[months.length - 1]) : '';

/** Calendar year of a month label inside an Indian FY ('2026-27': Apr–Dec → 2026, Jan–Mar → 2027). */
export function yearOf(month, fy) {
  const y = parseInt(fy, 10);
  return ['Jan', 'Feb', 'Mar'].includes(month) ? y + 1 : y;
}

export const fmtDate = (iso) => new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
export const fmtDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
