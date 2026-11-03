/* VIEW · WHATSAPP REPORT (WhatsApp messages sent from the portal, per institution, with what AiSensy's webhook reported) */
import { api } from '../api.js';
import { esc, nf, pct } from '../format.js';
import { $, chip } from '../ui.js';

let days = 30;
let openId = null;   // institute id of the open detail ('' = "Send test to me" messages), null = closed
let msgs = [];       // the open institution's messages
const TAPPED = { any: (m) => m.download_app || m.check_emi, app: (m) => m.download_app, emi: (m) => m.check_emi,
  none: (m) => !(m.download_app || m.check_emi) };

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const share = (n, of) => (of ? `<div class="fs-8 text-muted-2">${pct((n / of) * 100, 0)}</div>` : '');
const STATUS = { read: ['Read', 'green'], delivered: ['Delivered', 'blue'], sent: ['Sent', 'amber'], accepted: ['Accepted', 'amber'], failed: ['Failed', 'red'] };
const TEST_HELP = 'Sent in test mode to the test number (not to the parent), or from "Send test to me"';
const name = (o) => (o.institute_id ? o.institute_name : 'Send test to me (no institution)');
const mode = (o) => (o.tests === o.sent ? chip('Test', 'violet', TEST_HELP)
  : o.tests ? `${chip('Live', 'green')} ${chip(`${nf(o.tests)} test`, 'violet', TEST_HELP)}` : chip('Live', 'green', 'Sent to the parents'));

export async function renderWaReport() {
  const box = $('#warRows');
  box.innerHTML = '<tr><td colspan="11" class="text-muted-2">Loading…</td></tr>';
  try {
    const r = await api.whatsappReport(days);
    const t = r.totals;
    $('#warSummary').textContent = `Every WhatsApp message sent from this portal in the last ${nf(r.days)} days, per institution`
      + ` · ${nf(t.tests)} of ${nf(t.sent)} were tests` + (r.test_mode ? ' · WhatsApp is in test mode: messages go to the test number, not to parents' : '');
    $('#warKpis').innerHTML = [['Messages sent', t.sent], ['Delivered', t.delivered], ['Read', t.read], ['Failed', t.failed],
      ['Download App taps', t.download_app], ['Check EMI & Loan taps', t.check_emi]]
      .map(([k, v], i) => `<div class="col"><div class="card h-100"><div class="card-body"><div class="fs-7 text-muted-2">${k}</div>
        <div class="fs-4 fw-bold mt-1">${nf(v)}</div>${i ? share(v, t.sent) : `<div class="fs-8 text-muted-2">${nf(t.tests)} test · ${nf(t.sent - t.tests)} live</div>`}</div></div></div>`).join('');
    box.innerHTML = r.institutes.length ? r.institutes.map((o) => `<tr role="button" tabindex="0" data-iid="${esc(o.institute_id)}" data-name="${esc(name(o))}">
        <td><div class="fw-semibold">${esc(name(o))}</div><div class="fs-8 text-muted-2">${esc(o.institute_id || 'Campaigns › Send test to me')}</div></td>
        <td>${mode(o)}</td><td class="text-end">${nf(o.sent)}</td><td class="text-end">${nf(o.delivered)}${share(o.delivered, o.sent)}</td>
        <td class="text-end">${nf(o.read)}${share(o.read, o.sent)}</td><td class="text-end${o.failed ? ' text-danger' : ''}">${nf(o.failed)}</td>
        <td class="text-end">${nf(o.download_app)}</td><td class="text-end">${nf(o.check_emi)}</td>
        <td class="text-end">${nf(o.students)}</td><td class="text-nowrap fs-7">${when(o.first_sent)}</td><td class="text-nowrap fs-7">${when(o.last_sent)}</td></tr>`).join('')
      : `<tr><td colspan="11" class="text-muted-2">No WhatsApp messages were sent from this portal in the last ${nf(r.days)} days.</td></tr>`;
    if (openId !== null) {
      if (r.institutes.some((o) => o.institute_id === openId)) openDetail(openId, $('#warDetailTitle').textContent);
      else closeDetail();
    }
  } catch (err) {
    box.innerHTML = `<tr><td colspan="11" class="text-danger">${esc(err.message || 'Could not load the report')}</td></tr>`;
  }
}

async function openDetail(iid, title) {
  openId = iid;
  $('#warDetail').hidden = false;
  $('#warDetailTitle').textContent = title;
  const box = $('#warMsgRows');
  box.innerHTML = '<tr><td colspan="7" class="text-muted-2">Loading…</td></tr>';
  $('#warTapCount').textContent = '';
  try {
    msgs = (await api.whatsappReportMessages(iid, days)).messages;
    paintMessages();
  } catch (err) {
    box.innerHTML = `<tr><td colspan="7" class="text-danger">${esc(err.message || 'Could not load the messages')}</td></tr>`;
  }
}

function paintMessages() {
  const f = TAPPED[$('#warTap').value];
  const rows = f ? msgs.filter(f) : msgs;
  $('#warTapCount').textContent = f ? `${nf(rows.length)} of ${nf(msgs.length)}` : `${nf(msgs.length)} messages`;
  $('#warMsgRows').innerHTML = rows.map((m) => {
    const [label, tone] = STATUS[m.status] || [m.status, 'amber'];
    const steps = [['Sent', m.sent_ok_at], ['Delivered', m.delivered_at], ['Read', m.read_at]].filter(([, at]) => at)
      .map(([k, at]) => `<div class="fs-8 text-muted-2">${k} ${time(at)}</div>`).join('');
    const taps = [['Download App', m.download_app, m.app_at], ['Check EMI & Loan', m.check_emi, m.emi_at]].filter(([, on]) => on)
      .map(([k, , at]) => `<div>${esc(k)}${at ? ` <span class="fs-8 text-muted-2">${time(at)}</span>` : ''}</div>`).join('');
    return `<tr><td class="text-nowrap fs-7">${when(m.sent_at)}</td>
      <td>${m.test ? chip('Test', 'violet', TEST_HELP) : chip('Live', 'green')}</td>
      <td>${esc(m.student_name || '—')}</td><td class="text-nowrap">+${esc(m.phone)}</td>
      <td class="fs-7">${esc(m.template)}${m.pay_code ? `<div class="fs-8 text-muted-2">fee.s.gy/${esc(m.pay_code)}</div>` : ''}</td>
      <td>${chip(label, tone)}${steps}${m.error ? `<div class="fs-8 text-danger">${esc(m.error)}</div>` : ''}</td>
      <td class="fs-7">${taps || '<span class="text-muted-2">—</span>'}</td></tr>`;
  }).join('') || `<tr><td colspan="7" class="text-muted-2">${msgs.length ? 'No message matches this filter.' : 'No messages.'}</td></tr>`;
}

function closeDetail() { openId = null; $('#warDetail').hidden = true; }


export function initWaReport() {
  $('#warDays').addEventListener('change', (e) => { days = +e.target.value; renderWaReport(); });
  $('#warRefresh').addEventListener('click', () => renderWaReport());
  $('#warDetailClose').addEventListener('click', closeDetail);
  $('#warTap').addEventListener('change', paintMessages);
  const pick = (e) => {
    const tr = e.target.closest('tr[data-iid]');
    if (tr && (e.type === 'click' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openDetail(tr.dataset.iid, tr.dataset.name);
      $('#warDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  $('#warRows').addEventListener('click', pick);
  $('#warRows').addEventListener('keydown', pick);
}
