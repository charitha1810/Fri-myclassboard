/* VIEW · DUE MONTH-WISE ORGANISATIONS (schools with fees due in a month, from MCBMaster's USP_GET_OrganisationDueMonths) */
import { api } from '../api.js';
import { esc, nf } from '../format.js';
import { $ } from '../ui.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let data = null;
let query = '';

function paint() {
  if (!data) return;
  const q = query.trim().toLowerCase();
  const rows = data.schools.filter((s) => !q || s.name.toLowerCase().includes(q) || s.db.toLowerCase().includes(q) || String(s.org_id) === q);
  $('#dmTitle').textContent = `Schools with fees due in ${data.label} · ${nf(rows.length)}${q ? ` of ${nf(data.schools.length)}` : ''}`;
  $('#dmRows').innerHTML = rows.length ? rows.map((s, i) => `<tr>
      <td class="text-end text-muted-2">${nf(i + 1)}</td>
      <td>${s.in_portal ? `<a href="#institute/${encodeURIComponent(s.id)}" class="fw-semibold">${esc(s.name)}</a>` : `<span class="fw-semibold">${esc(s.name)}</span>`}</td>
      <td>${esc(s.db)}</td><td class="text-end">${esc(s.org_id)}</td><td>${esc(data.label)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="text-muted-2">${data.schools.length ? 'No school matches the search.' : `No school has fees due in ${esc(data.label)}.`}</td></tr>`;
}

export async function renderDueMonths() {
  const m = +$('#dmMonth').value, y = +$('#dmYear').value;
  $('#dmRows').innerHTML = '<tr><td colspan="5" class="text-muted-2">Loading…</td></tr>';
  try {
    data = await api.dueMonths(m, y);
    $('#dmSummary').textContent = `${nf(data.schools.length)} schools have fees due in ${data.label}`;
    paint();
  } catch (err) {
    data = null;
    $('#dmRows').innerHTML = `<tr><td colspan="5" class="text-danger">${esc(err.message || 'Could not load the schools')}</td></tr>`;
  }
}

export function initDueMonths() {
  const now = new Date();
  $('#dmMonth').innerHTML = MONTHS.map((n, i) => `<option value="${i + 1}"${i === now.getMonth() ? ' selected' : ''}>${n}</option>`).join('');
  const y = now.getFullYear();
  $('#dmYear').innerHTML = [y - 2, y - 1, y, y + 1].map((v) => `<option value="${v}"${v === y ? ' selected' : ''}>${v}</option>`).join('');
  $('#dmMonth').addEventListener('change', renderDueMonths);
  $('#dmYear').addEventListener('change', renderDueMonths);
  $('#dmSearch').addEventListener('input', (e) => { query = e.target.value; paint(); });
}
