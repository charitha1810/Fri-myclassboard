/* Small UI primitives shared by every view. */
import { esc } from './format.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const BS = window.bootstrap || null;

export const ic = (name, cls) => `<svg class="bi${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#bi-${name}"></use></svg>`;
export const chip = (label, tone, help) => `<span class="chip chip-${tone}"${help ? ` title="${esc(help)}"` : ''}>${esc(label)}</span>`;
export const avatar = (o) => o ? `<span class="avatar" title="${esc(o)}">${esc(o)}</span>` : '<span class="avatar-empty">Assign</span>';

let toastTimer = null;
export function toast(msg) {
  const el = $('#appToast');
  $('#toastBody').textContent = msg;
  if (BS) { BS.Toast.getOrCreateInstance(el, { delay: 3200 }).show(); return; }
  el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
export const toastError = (err) => toast(err && err.message ? err.message : 'Something went wrong');

export function showModal(el) { if (BS) BS.Modal.getOrCreateInstance(el).show(); }
export function hideOffcanvas(el) { if (BS) { const i = BS.Offcanvas.getInstance(el); if (i) i.hide(); } }

export function setBar(sel, v) {
  const el = $(sel);
  el.setAttribute('aria-valuenow', v.toFixed(1)); el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
  el.firstElementChild.style.width = Math.min(100, Math.max(0, v)).toFixed(1) + '%';
}

/** Set textContent on every element matching a selector. */
export const fill = (sel, text) => $$(sel).forEach((e) => { e.textContent = text; });

/** Wrap an async action: disables the trigger while it runs and toasts on failure. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (err) { toastError(err); return undefined; } finally { if (btn) btn.disabled = false; }
}
