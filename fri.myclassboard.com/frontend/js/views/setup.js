/* Revenue settings (offcanvas) and Consent register (modal). */
import { D, invalidate } from '../store.js';
import { api } from '../api.js';
import { esc, nf, pct, cr } from '../format.js';
import { consentState } from '../metrics.js';
import { $, chip, toastError } from '../ui.js';

const LIMIT = 100;

// ---------------- Revenue settings ----------------
export function syncSettingsForm() {
  const s = D.settings;
  $('#setTake').value = s.take_bps; $('#setLoan').value = s.loan_fee_pct; $('#setConv').value = s.conv_pct;
  $('#setTarget').value = s.quarter_target_rs ?? '';
  settingsLabels();
  if (D.gw && D.modes) {
    const tot = D.modes.month_totals.reduce((a, b) => a + b, 0);
    $('#settingsNote').textContent = `Gateway share = “Online Payment” mode (${cr(D.gw.summary.fytd)}) ÷ all payment modes (${cr(tot)}), FY ${D.meta.fy}, complete months only.`;
  }
}
function settingsLabels() {
  const s = D.settings;
  $('#setTakeOut').textContent = s.take_bps + ' bps (' + pct(s.take_bps / 100, 2) + ')';
  $('#setLoanOut').textContent = pct(s.loan_fee_pct, 2);
  $('#setConvOut').textContent = s.conv_pct + '%';
}

let saveTimer = null;
export function bindSettingsEvents(rerender) {
  const apply = (k, v) => {
    D.settings[k] = v;
    settingsLabels(); invalidate(); rerender();
    clearTimeout(saveTimer);
    $('#settingsSaved').textContent = 'Saving…';
    saveTimer = setTimeout(async () => {
      try { await api.saveSettings(D.settings); $('#settingsSaved').textContent = 'Saved'; }
      catch (err) { $('#settingsSaved').textContent = 'Not saved: ' + err.message; }
    }, 500);
  };
  $('#setTake').addEventListener('input', (e) => apply('take_bps', +e.target.value));
  $('#setLoan').addEventListener('input', (e) => apply('loan_fee_pct', +e.target.value));
  $('#setConv').addEventListener('input', (e) => apply('conv_pct', +e.target.value));
  $('#setTarget').addEventListener('change', (e) => apply('quarter_target_rs', e.target.value === '' ? null : Math.max(0, +e.target.value)));
}

// ---------------- Consent register ----------------
export function renderConsent() {
  const q = $('#consentSearch').value.trim().toLowerCase();
  const f = $('#consentFilter').value;
  const rows = D.inst.institutes
    .filter((x) => (!q || x.name.toLowerCase().includes(q) || x.db.toLowerCase().includes(q)) && (f === 'all' || consentState(x) === f))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lab = { y: chip('Granted', 'green'), p: chip('Pending', 'amber'), n: chip('Not asked', 'gray') };
  const next = { n: 'p', p: 'y', y: 'n' };
  const cellBtn = (x, ch) => `<button type="button" class="consent-btn" data-consent="${esc(x.id)}|${ch}|${next[x.consent[ch]]}" aria-label="${esc(x.name)} ${ch}: change">${lab[x.consent[ch]]}</button>`;
  $('#consentRows').innerHTML = rows.slice(0, LIMIT).map((x) => `<tr><td class="fw-semibold">${esc(x.name)}<div class="fs-8 text-muted-2 font-mono fw-normal">${esc(x.db)}</div></td>
    <td>${cellBtn(x, 'sms')}</td><td>${cellBtn(x, 'wa')}</td><td>${cellBtn(x, 'app')}</td>
    <td class="text-end">${Object.values(x.consent).every((v) => v === 'y') ? '<span class="fs-8 text-faint">Complete</span>' : `<button class="btn btn-sm btn-quiet" data-request="${esc(x.id)}">Mark requested</button>`}</td></tr>`).join('')
    + (rows.length > LIMIT ? `<tr><td colspan="5" class="text-center fs-8 text-muted-2">Showing ${LIMIT} of ${nf(rows.length)} — search to narrow down.</td></tr>` : '')
    + (rows.length ? '' : '<tr><td colspan="5" class="text-center text-muted-2 py-4">No institutes match.</td></tr>');
}

/** Update one channel locally + on the server, then re-render whatever is showing. */
export async function setConsent(id, channel, state, rerender) {
  const x = D.inst.institutes.find((i) => i.id === id);
  if (!x) return;
  const prev = x.consent[channel];
  x.consent[channel] = state; invalidate(); rerender();
  try { await api.setConsent(id, channel, state); }
  catch (err) { x.consent[channel] = prev; invalidate(); rerender(); toastError(err); }
}

export async function requestConsent(id, rerender) {
  const x = D.inst.institutes.find((i) => i.id === id);
  if (!x) return;
  await api.requestConsent(id);
  ['sms', 'wa', 'app'].forEach((k) => { if (x.consent[k] === 'n') x.consent[k] = 'p'; });
  invalidate(); rerender();
  return x.name;
}
