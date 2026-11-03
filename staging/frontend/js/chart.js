/* Dependency-free SVG stacked-column charts with hover / keyboard tooltips. */
import { esc } from './format.js';

const CHARTS = {};

/* Chart palette — validated for light & dark in the original design. */
const PAL = {
  light: { pg: '#5B36E0', neft: '#9C86F0', cash: '#E0560B', chq: '#2E7FC4', card: '#D99A1E', oth: '#B4B8C2', loan: '#2E7FC4', ecs: '#1F9D8B', ln: '#C2417E', surface: '#FFFFFF' },
  dark: { pg: '#6C49DB', neft: '#A382CA', cash: '#E06623', chq: '#2D86C8', card: '#C48800', oth: '#5A5E6B', loan: '#2D86C8', ecs: '#2BA595', ln: '#C9578E', surface: '#17151F' }
};
export const theme = () => document.documentElement.getAttribute('data-bs-theme') || 'light';
export const pal = () => PAL[theme()] || PAL.light;

function niceScale(maxV) {
  if (!(maxV > 0)) return { max: 1, step: 0.25 };
  const raw = maxV / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(maxV / step - 1e-9) * step, step };
}

function roundTop(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * spec: { labels, series:[{name,color,values}], height, yMax?, yStep?, yFmt, sub?, subShort?,
 *         caps?:[idx], capFmt?, colorAt?(series, i), aria?(i), tip(i) -> html, onClick?(i) -> open that month's details }
 */
export function drawChart(id, spec) { CHARTS[id] = spec; paintChart(id); }

export function paintChart(id) {
  const el = document.getElementById(id), spec = CHARTS[id];
  if (!el || !spec || el.offsetParent === null) return;              // only paint what is on screen
  const W = Math.max(280, Math.round(el.getBoundingClientRect().width || 600));
  const H = spec.height || 260;
  const m = { l: 56, r: 10, t: 24, b: spec.sub ? 46 : 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const n = spec.labels.length || 1, band = pw / n, bw = Math.min(spec.segFmt ? 56 : 24, band * 0.62);
  const totals = spec.labels.map((_, i) => spec.series.reduce((acc, s) => acc + (s.values[i] || 0), 0));
  const sc = spec.yMax ? { max: spec.yMax, step: spec.yStep } : niceScale(Math.max(0, ...totals));
  const y = (v) => m.t + ph - (v / sc.max) * ph;
  const subs = spec.sub ? (band < 70 && spec.subShort ? spec.subShort : spec.sub) : null;
  let out = '';
  for (let t = 0; t <= sc.max + 1e-9; t += sc.step) {
    const yy = Math.round(y(t)) + 0.5;
    out += `<line class="${t === 0 ? 'base' : 'grid'}" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"></line>`;
    out += `<text class="ytick" x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${esc(spec.yFmt(t))}</text>`;
  }
  spec.labels.forEach((lab, i) => {
    const cx = m.l + band * (i + 0.5), x0 = cx - bw / 2;
    const segs = spec.series.map((s) => ({ s, v: s.values[i] || 0 })).filter((o) => o.v > 0);
    let acc = 0, bars = '';
    segs.forEach((o, k) => {
      const top = y(acc + o.v), bot = y(acc); acc += o.v;
      const isTop = k === segs.length - 1;
      const gap = isTop ? 0 : 2;                                   // 2px surface gap between stacked segments
      const hgt = Math.max(bot - top - gap, Math.min(bot - top, 1));
      const col = spec.colorAt ? spec.colorAt(o.s, i) : o.s.color;
      bars += isTop ? `<path class="bar" d="${roundTop(x0, top, bw, hgt, 4)}" fill="${col}"></path>`
        : `<rect class="bar" x="${x0}" y="${top + gap}" width="${bw}" height="${hgt}" fill="${col}"></rect>`;
      // The value printed inside the segment, when it is big enough to hold it.
      if (spec.segFmt && hgt >= 14 && bw >= 30) {
        const txt = spec.segFmt(o.v, o.s, i, totals[i]);
        if (txt) bars += `<text class="seglbl" x="${cx}" y="${top + gap + hgt / 2 + 4}" text-anchor="middle" fill="${inkOn(col)}">${esc(txt)}</text>`;
      }
    });
    // The exact total above the column, when the column's slot is wide enough to hold the full figure.
    if (totals[i] > 0 && (spec.capAll || (spec.caps && spec.caps.includes(i)))) {
      const cap = spec.capFmt(totals[i], i);
      if (cap.length * 6.8 <= band - 4) bars += `<text class="cap" x="${cx}" y="${y(totals[i]) - 7}" text-anchor="middle">${esc(cap)}</text>`;
    }
    bars += `<text class="xtick" x="${cx}" y="${H - m.b + 18}" text-anchor="middle">${esc(lab)}</text>`;
    if (subs) bars += `<text class="xsub" x="${cx}" y="${H - m.b + 33}" text-anchor="middle">${esc(subs[i])}</text>`;
    bars += `<rect class="hit" x="${cx - band / 2}" y="${m.t}" width="${band}" height="${ph}" tabindex="0" data-i="${i}"${spec.onClick ? ' role="button" style="cursor:pointer"' : ''} aria-label="${esc((spec.aria ? spec.aria(i) : lab) + (spec.onClick ? '. Press Enter for the details of this month.' : ''))}"></rect>`;
    out += `<g class="cat" data-i="${i}">${bars}</g>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">${out}</svg><div class="chart-tip" hidden></div>`;
  el._bandX = spec.labels.map((_, i) => m.l + band * (i + 0.5));
  el._svgW = W;
  if (!el._bound) {                                                 // one set of listeners per chart host
    el._bound = true;
    const show = (ev) => {
      const hit = ev.target && ev.target.closest ? ev.target.closest('.hit') : null; if (!hit) return;
      const i = +hit.getAttribute('data-i'), sp = CHARTS[id]; if (!sp) return;
      const tip = el.querySelector('.chart-tip'); if (!tip) return;
      el.classList.add('hovering');
      el.querySelectorAll('.cat').forEach((g) => g.classList.toggle('on', +g.getAttribute('data-i') === i));
      tip.innerHTML = sp.tip(i); tip.hidden = false;
      const scale = el.getBoundingClientRect().width / (el._svgW || 1);
      const half = tip.offsetWidth / 2, wEl = el.clientWidth;
      tip.style.left = Math.max(half, Math.min(wEl - half, el._bandX[i] * scale)) + 'px';
      tip.style.top = '0px';
    };
    const hide = () => {
      el.classList.remove('hovering');
      el.querySelectorAll('.cat.on').forEach((g) => g.classList.remove('on'));
      const t = el.querySelector('.chart-tip'); if (t) t.hidden = true;
    };
    el.addEventListener('mouseover', show); el.addEventListener('focusin', show);
    el.addEventListener('mouseleave', hide); el.addEventListener('focusout', hide);
    // A click (or Enter / Space) on a month opens what that column is made of.
    const open = (ev) => {
      const hit = ev.target && ev.target.closest ? ev.target.closest('.hit') : null, sp = CHARTS[id];
      if (!hit || !sp || !sp.onClick) return false;
      hide(); sp.onClick(+hit.getAttribute('data-i'));
      return true;
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && open(ev)) ev.preventDefault(); });
  }
}

/** Dark or white label text, whichever reads better on a fill colour. */
export function inkOn(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return '#fff';
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#1D1B26' : '#fff';
}

export const repaintAll =() => Object.keys(CHARTS).forEach(paintChart);
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(repaintAll, 120); });

export const tipRow = (color, name, val) => `<div class="r"><span><i class="sw" style="background:${color}"></i>${esc(name)}</span><span>${val}</span></div>`;
