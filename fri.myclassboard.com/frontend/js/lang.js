/* Simple / Advanced wording.
   Simple = plain English for everyone; Advanced = the analyst / database terms (PG, partner flag, txns, avg ticket…)
   plus extra detail. The choice lives on <html data-lang>, so switching never needs new data:
   - JS-built text uses T(simple, advanced): both are rendered and CSS shows one.
   - Static HTML carries the advanced wording in data-adv (and data-adv-title for tooltips); applyLang swaps it in.
   - .simple-only / .adv-only blocks are shown in one mode only. */
const KEY = 'mcb-lang';

export const lang = () => (document.documentElement.dataset.lang === 'adv' ? 'adv' : 'simple');
export const isAdv = () => lang() === 'adv';

/** Both wordings as HTML (arguments are already-escaped HTML). */
export const T = (simple, adv) => (adv == null || adv === simple ? simple : `<span class="t-s">${simple}</span><span class="t-a">${adv}</span>`);
/** Pick one wording for places that cannot hold HTML (title attributes, CSV, aria). */
export const pick = (simple, adv) => (isAdv() && adv != null ? adv : simple);

export function savedLang() {
  try { return localStorage.getItem(KEY) === 'adv' ? 'adv' : 'simple'; } catch (e) { return 'simple'; }
}

/** Switch wording; static elements keep their simple text in data-simple so the swap is reversible. */
export function applyLang(l) {
  const root = document.documentElement;
  root.dataset.lang = l === 'adv' ? 'adv' : 'simple';
  try { localStorage.setItem(KEY, root.dataset.lang); } catch (e) {}
  document.querySelectorAll('[data-adv]').forEach((el) => {
    if (el.dataset.simple === undefined) el.dataset.simple = el.innerHTML;
    el.innerHTML = root.dataset.lang === 'adv' ? el.dataset.adv : el.dataset.simple;
  });
  document.querySelectorAll('[data-adv-title]').forEach((el) => {
    if (el.dataset.simpleTitle === undefined) el.dataset.simpleTitle = el.getAttribute('title') || '';
    el.setAttribute('title', root.dataset.lang === 'adv' ? el.dataset.advTitle : el.dataset.simpleTitle);
  });
  document.querySelectorAll('[data-lang-btn]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.langBtn === root.dataset.lang)));
}
