/* Thin client for the FastAPI backend. Every network call in the portal goes through here. */

// Same origin by default (FastAPI serves this page). Override with window.MCB_API_BASE before app.js loads.
const BASE = (window.MCB_API_BASE || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, detail, code) { super(detail || `Request failed (${status})`); this.status = status; this.code = code || ''; }
}

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
  } catch (err) {
    throw new ApiError(0, 'Cannot reach the server. Check that the API is running.');
  }
  if (res.status === 401) { window.location.replace('/login'); throw new ApiError(401, 'Please sign in.', 'signed_out'); }
  if (!res.ok) {
    let detail = '', code = '';
    try { const j = await res.json(); detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); code = j.code || ''; } catch (e) {}
    const err = new ApiError(res.status, detail, code);
    if (code === 'database_unavailable' || code === 'database_error') window.dispatchEvent(new CustomEvent('mcb:db-down', { detail: err }));
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/** Query string from a params object, skipping empty values. Accepts a bare FY string for convenience. */
const q = (p) => {
  const o = typeof p === 'string' ? { fy: p } : (p || {});
  const s = Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return s ? '?' + s : '';
};

// Analytics calls take { fy, from, to, db, partner, coverage, gateway, inst } — the global filters.
export const api = {
  meta: (fy) => req('GET', '/api/meta' + q(fy)),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (s) => req('PUT', '/api/settings', s),
  paymentModes: (p) => req('GET', '/api/payment-modes' + q(p)),
  monthDetail: (p) => req('GET', '/api/month-detail' + q(p)),
  monthlySummary: (p) => req('GET', '/api/monthly-summary' + q(p)),
  totalReconciliation: (fy) => req('GET', '/api/total-reconciliation' + q(fy)),
  gateways: (p) => req('GET', '/api/gateways' + q(p)),
  loans: (p) => req('GET', '/api/loans' + q(p)),
  gatewayMaster: (p) => req('GET', '/api/gateway-master' + q(p)),
  commission: (p) => req('GET', '/api/commission' + q(p)),
  suggestions: (p, body) => req('POST', '/api/suggestions' + q(p), body),
  aiStatus: () => req('GET', '/api/ai/status'),
  verify: (fy) => req('GET', '/api/health/data' + q(fy)),
  institutes: (p) => req('GET', '/api/institutes' + q(p)),
  institute: (id, p) => req('GET', `/api/institutes/${encodeURIComponent(id)}` + q(p)),
  filterOptions: (fy) => req('GET', '/api/filter-options' + q(fy)),
  alerts: (p) => req('GET', '/api/alerts' + q(p)),
  refresh: () => req('POST', '/api/refresh'),
  version: () => req('GET', '/api/version'),
  setConsent: (id, channel, state) => req('PUT', `/api/institutes/${encodeURIComponent(id)}/consent`, { channel, state }),
  assignOwner: (ids, owner) => req('PATCH', '/api/institutes/owner', { ids, owner }),
  notes: (id) => req('GET', `/api/institutes/${encodeURIComponent(id)}/notes`),
  activity: (id) => req('GET', `/api/institutes/${encodeURIComponent(id)}/activity`),
  addActivity: (id, text) => req('POST', `/api/institutes/${encodeURIComponent(id)}/activity`, { text }),
  addNote: (id, text, followUp) => req('POST', `/api/institutes/${encodeURIComponent(id)}/notes`, { text, follow_up: followUp || null }),
  requestConsent: (id) => req('POST', `/api/institutes/${encodeURIComponent(id)}/consent-request`),
  pipeline: () => req('GET', '/api/pipeline'),
  pipelineOwners: () => req('GET', '/api/pipeline/owners'),
  addDeal: (deal) => req('POST', '/api/pipeline', deal),
  moveDeal: (id, stage) => req('PATCH', `/api/pipeline/${encodeURIComponent(id)}`, { stage }),
  removeDeal: (id) => req('DELETE', `/api/pipeline/${encodeURIComponent(id)}`),
  saveCampaign: (c) => req('POST', '/api/campaigns', c),
  testCampaign: (c) => req('POST', '/api/campaigns/test', c),
  studentTotals: (ids) => req('GET', '/api/campaigns/student-totals?ids=' + encodeURIComponent(ids.join(','))),
  whatsappTemplates: () => req('GET', '/api/whatsapp/templates'),
  dueMonths: (month, year) => req('GET', `/api/campaigns/due-months?month=${encodeURIComponent(month)}&year=${encodeURIComponent(year)}`),
  whatsappReport: (days) => req('GET', '/api/whatsapp/report?days=' + encodeURIComponent(days)),
  whatsappReportMessages: (iid, days) => req('GET', '/api/whatsapp/report/messages?institute_id=' + encodeURIComponent(iid) + '&days=' + encodeURIComponent(days)),
  whatsappTest: (body) => req('POST', '/api/whatsapp/test-send', body),
  whatsappSend: (body) => req('POST', '/api/campaigns/whatsapp-send', body),
  pushSend: (body) => req('POST', '/api/campaigns/push-send', body),
  dueList: (id) => req('GET', '/api/campaigns/due-students/' + encodeURIComponent(id)),
  dueStudents: (ids, month, filters) => req('GET', '/api/campaigns/due-students?ids=' + encodeURIComponent(ids.join(','))
    + '&month=' + encodeURIComponent(month || '') + '&filters=' + encodeURIComponent((filters || []).join(','))),
  logout: () => req('POST', '/api/auth/logout')
};
