/* Export preview: every CSV export opens this pop-up first; the file downloads only after "Download CSV". */
import { esc, nf } from './format.js';
import { $, showModal } from './ui.js';

const PREVIEW_ROWS = 50;
let pending = null;   // { head, rows, filename } of the export on screen

const csvCell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';

/** Show `rows` (arrays matching `head`) in the preview pop-up; nothing is downloaded yet. */
export function previewExport(title, head, rows, filename) {
  pending = { head, rows, filename };
  $('#exportTitle').textContent = title;
  $('#exportSub').textContent = `${nf(rows.length)} row${rows.length === 1 ? '' : 's'} · ${nf(head.length)} columns · ${filename}`
    + (rows.length > PREVIEW_ROWS ? ` · preview shows the first ${PREVIEW_ROWS}` : '');
  $('#exportTable').innerHTML = `<thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>`
    + (rows.slice(0, PREVIEW_ROWS).map((r) => `<tr>${r.map((v) => `<td>${esc(v ?? '')}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${head.length}" class="text-center text-muted-2 py-4">Nothing to export with the current filters.</td></tr>`)
    + '</tbody>';
  $('#exportGo').disabled = !rows.length;
  showModal($('#exportModal'));
}

export function bindExportPreview() {
  $('#exportGo').addEventListener('click', () => {
    if (!pending) return;
    const csv = [pending.head, ...pending.rows].map((r) => r.map(csvCell).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = pending.filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    pending = null;
  });
}
