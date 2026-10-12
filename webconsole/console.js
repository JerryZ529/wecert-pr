const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

// Local, monochrome icons keep the file preview independent of network access.
function icon(name) {
  const paths = {
    certificate: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z M12 9v5 M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.certificate}</svg>`;
}

const state = {
  base: '', creating: false, live: false, sessionOK: false, canRead: false, canAdmin: false,
  deployment: null, deploymentError: "", lastSynced: null, syncing: false, syncError: '',
  accounts: [], certificates: [], uin: 'all', status: 'all',
  binding: 'all', cloud: 'all',
  sort: 'expiry', search: '', selected: '', detailOpen: false, collapsed: new Set()
};

// Clouds are read from the accounts the daemon reports, so a cloud appears in
// the filter as soon as wecert can deploy into it. Accounts saved without one
// are Tencent Cloud: that is the only deployment target the daemon has today.
const CLOUD_LABELS = {
  tencentcloud: 'Tencent Cloud', aws: 'AWS', aliyun: 'Alibaba Cloud',
  gcp: 'Google Cloud', azure: 'Azure'
};
const DEFAULT_CLOUD = 'tencentcloud';

function cloudOf(cert) {
  const account = state.accounts.find((item) => item.uin && item.uin === cert.uin);
  return (account && String(account.cloud || '').trim()) || DEFAULT_CLOUD;
}

function cloudLabel(id) {
  return CLOUD_LABELS[id] || id;
}

// Tencent CLB is the only binding type exposed by this console.
const TARGET_LABELS = { tencent: 'Tencent CLB' };
const DEFAULT_TARGET = 'tencent';

function targetOf(cert) {
  if (cert.deploy && cert.deploy.enabled === false) return 'none';
  return (cert.deploy && String(cert.deploy.target || '').trim()) || DEFAULT_TARGET;
}

function targetLabel(id) {
  return TARGET_LABELS[id] || (id === 'none' ? 'Issue only' : 'Unsupported deployment');
}

function targetMatches(cert, filter) {
  if (filter === 'all') return true;
  return targetOf(cert) === filter;
}
let toastTimer;
const operationLog = [];
let detailReturnFocus;
function recordOperation(name, message) {
  operationLog.unshift({ name, message, time: new Date().toLocaleTimeString() });
  operationLog.splice(30);
  if (state.detailOpen) renderDetail();
}
function isCLBBinding(item) {
  return !item.resourceType || String(item.resourceType).toLowerCase() === 'clb';
}
function clbBindingCount(cert) {
  if ((cert.deploy?.target || state.deployment?.target || DEFAULT_TARGET) !== 'tencent') return 0;
  const items = cert.bindings?.items || [];
  return items.length ? items.filter(isCLBBinding).length : (cert.bindings?.count || 0);
}
// One load balancer as the operator names it: the ID the API takes and the name the Tencent Cloud
// console shows. Either half can be missing (an enumeration that did not report a name), so each is
// rendered only when it is there rather than printing a placeholder for both.
function clbLabel(item) {
  const id = item.loadBalancerId || 'CLB ID not reported';
  return item.loadBalancerName ? `${id} (${item.loadBalancerName})` : id;
}

function bindingSummary(cert) {
  if ((cert.deploy?.target || state.deployment?.target || DEFAULT_TARGET) !== 'tencent') return 'CLB deployment unavailable';
  const items = (cert.bindings?.items || []).filter(isCLBBinding);
  if (!items.length) {
    const count = clbBindingCount(cert);
    return count ? `${count} CLB binding${count === 1 ? '' : 's'} · details not reported` : 'No CLB bindings reported';
  }
  const item = items[0];
  // No port is claimed when the enumeration did not report one: the SSL payload carries the
  // listener but not its port, and "Port not reported" in a cell whose job is to identify a
  // listener is noise rather than information.
  const endpoint = item.protocol ? `${item.protocol}${item.port ? ` :${item.port}` : ''}` : '';
  const more = items.length > 1 ? `+${items.length - 1} more` : '';
  return [clbLabel(item), item.region || 'Region not reported', endpoint, more].filter(Boolean).join(' · ');
}

// The line under the binding text. A bare freshness word says nothing about when: an operator who
// just changed something in the Tencent Cloud console needs to know whether what they are reading
// predates their change.
function bindingsCaption(cert) {
  const b = cert.bindings || {};
  const count = clbBindingCount(cert);
  const noun = `${count} binding${count === 1 ? '' : 's'}`;
  if (b.observedAt) {
    const parsed = new Date(b.observedAt);
    const at = Number.isNaN(parsed.getTime()) ? '' : ` ${parsed.toISOString().slice(11, 16)} UTC`;
    return `${noun} · observed${at}${b.complete === false ? ' · partial' : ''}`;
  }
  if (b.freshness === 'store') return `${noun} · from the deployment record`;
  return `${noun} · ${b.freshness || 'freshness not reported'}`;
}

// Whether the certificate is bound anywhere -- a different question from the status pill, which
// reports the deployment and the probe (does the name actually serve this certificate). In a
// deployment whose names do not resolve yet the pill reads "probe unreachable" whatever the binding
// state is, and the binding answer should not have to be found in the next column because of it.
function bindingState(cert) {
  const items = (cert.bindings?.items || []).filter(isCLBBinding);
  if (items.length) return { label: items.length === 1 ? 'Bound · 1 CLB' : `Bound · ${items.length} CLBs`, tone: 'ok' };
  if (clbBindingCount(cert) > 0) return { label: 'Bound · from record', tone: 'ok' };
  if (cert.bindings && cert.bindings.complete === false) return { label: 'Binding unknown', tone: 'warn' };
  return { label: 'Not bound', tone: 'warn' };
}

// What the detail panel says under the binding rows: an enumeration with an observation time is
// evidence, one without it is a record of what wecert deployed. Keeping the two apart is the whole
// reason the payload carries an observation time.
function bindingsEvidence(cert) {
  const b = cert.bindings || {};
  if (b.observedAt) {
    const parsed = new Date(b.observedAt);
    if (!Number.isNaN(parsed.getTime())) {
      const when = parsed.toISOString().replace('T', ' ').slice(0, 16);
      const partial = b.complete === false ? ' At least one region did not answer, so this list is a lower bound.' : '';
      return `Enumerated from Tencent Cloud at ${when} UTC.${partial}`;
    }
  }
  if (b.freshness === 'store') {
    return 'From the deployment record: this certificate is confirmed as bound, but the resources have not been enumerated on this run.';
  }
  return 'No enumeration has run for this certificate yet, so the binding details are unknown.';
}

// The certificate cell's second line: the cloud certificate ID, which is how this row is matched
// against the Tencent Cloud SSL console. The wecert name is not visible in that console at all.
function certificateIdLine(cert) {
  if (!cert.deployedCertId) return '';
  return `<span class="sub certificate-id" title="Tencent Cloud SSL certificate ID">${escapeHTML(cert.deployedCertId)}</span>`;
}

// Up to three names, then a count. Stacked rather than joined by separators: three host names on
// one line is where a fixed-layout table starts cutting names in the middle.
const MAX_ROW_DOMAINS = 3;
function domainsCell(cert) {
  const list = (cert.domains || []).filter(Boolean);
  if (!list.length) return '<span class="unbound">—</span>';
  const shown = list.slice(0, MAX_ROW_DOMAINS);
  const hidden = list.length - shown.length;
  return `<div class="domain-cell">${shown
    .map((domain) => `<span class="domain-line" title="${escapeHTML(domain)}">${escapeHTML(domain)}</span>`)
    .join('')}${hidden ? `<span class="domain-more">+${hidden} more</span>` : ''}</div>`;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3500);
}

const REQUEST_TIMEOUT_MS = 15000;
const pendingRequests = new Set();
let syncVersion = 0;

function assertSecureTransport(base = state.base) {
  const url = new URL(base);
  if (url.origin !== location.origin) throw new Error('Use this page’s origin. Proxy /api, /hook and /admin to the daemon on the same host.');
  if (url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
  throw new Error('Use HTTPS before connecting; plain HTTP is only allowed on loopback.');
}

function clearLegacyTokens() {
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      for (const key of ['wecert.token', 'wecert.adminToken', 'wecert.base']) window[storage].removeItem(key);
    } catch { /* Storage can be unavailable in restricted browsers. */ }
  }
  const url = new URL(location.href);
  for (const key of ['token', 'adminToken', 'admin']) url.searchParams.delete(key);
  if (url.href !== location.href) history.replaceState(null, '', url);
}

async function fetchJSON(base, method, path, body) {
  assertSecureTransport(base);
  const controller = new AbortController();
  pendingRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method, headers, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store'
    });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`Invalid API response (${response.status}). Check the reverse proxy configuration.`); }
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timed out or was cancelled. Retry when the daemon is reachable.');
    throw error;
  } finally {
    clearTimeout(timeout);
    pendingRequests.delete(controller);
  }
}

async function request(method, path, body, admin = false) {
  if (!state.base || !state.sessionOK) throw new Error('Connect in System settings first.');
  if (admin ? !state.canAdmin : !state.canRead) throw new Error(admin ? 'An admin session is required.' : 'A read session is required.');
  return fetchJSON(state.base, method, path, body);
}

function setSession(session) {
  state.canRead = session.read === true;
  state.canAdmin = session.admin === true;
  state.sessionOK = state.canRead || state.canAdmin;
  for (const id of ['new-certificate', 'notifications', 'save-uin', 'create-submit']) {
    const button = document.getElementById(id);
    if (button) { button.disabled = !state.canAdmin || (id === 'create-submit' && state.creating); button.title = state.canAdmin ? '' : 'Connect with an admin token to manage certificates.'; }
  }
  const logout = document.getElementById('disconnect-backend');
  if (logout) logout.hidden = !state.sessionOK;
}

function renderConnection() {
  const element = $('#connection-status');
  element.classList.toggle('live', state.live && !state.syncError);
  element.classList.toggle('stale', Boolean(state.syncError));
  element.lastChild.textContent = state.syncing ? 'Syncing…' : state.syncError ? 'Data outdated' : state.live ? 'Live inventory' : 'Disconnected';
  const stamp = state.lastSynced ? `Last synced ${state.lastSynced.toLocaleString()}` : 'No successful sync yet';
  element.title = `${stamp}${state.canAdmin ? ' · Management access' : state.canRead ? ' · Read access' : ''}`;
  $('#refresh-inventory').disabled = !state.canRead || state.syncing;
  let sync = document.getElementById('last-sync');
  if (!sync) { sync = document.createElement('span'); sync.id = 'last-sync'; $('#inventory-footer').after(sync); }
  sync.textContent = state.lastSynced ? stamp : '';
}

function statusInfo(cert) {
  if (cert.status === 'not_issued') return { label: 'Not issued', lifecycle: 'Ready to issue', tone: 'ready', dot: 'warn' };
  if (cert.status === 'expired' || cert.daysLeft != null && cert.daysLeft < 0) return { label: 'Expired', lifecycle: 'Expired', tone: 'expired', dot: 'bad' };
  if (cert.status === 'failing') return { label: 'Error', lifecycle: 'Needs attention', tone: 'expired', dot: 'bad' };
  if (cert.status === 'waiting_manual_bind') return { label: 'Bind needed', lifecycle: 'Awaiting binding', tone: 'renewing', dot: 'warn' };
  if (cert.daysLeft != null && cert.daysLeft <= 30) return { label: 'Expiring', lifecycle: 'Expiring', tone: 'renewing', dot: 'warn' };
  if (cert.status !== 'ok') return { label: String(cert.status || 'Unknown').replaceAll('_', ' '), lifecycle: 'Needs review', tone: 'renewing', dot: 'warn' };
  return { label: 'Active', lifecycle: 'Issued', tone: 'issued', dot: 'ok' };
}

function expiry(cert) {
  if (!cert.notAfter) return '—';
  const parsed = new Date(cert.notAfter);
  return Number.isNaN(parsed.getTime()) ? cert.notAfter : parsed.toISOString().slice(0, 10);
}

function primaryAction(cert) {
  if (cert.status === 'not_issued') return ['issue', 'Issue'];
  if (cert.status === 'failing') return ['view', 'Inspect'];
  if (cert.status === 'expired' || cert.daysLeft != null && cert.daysLeft <= 30) return ['renew', 'Renew'];
  if (cert.status === 'waiting_manual_bind') return ['bindings', 'Bindings'];
  return ['view', 'Details'];
}

function bindingIssue(cert) {
  if ((cert.deploy?.target || state.deployment?.target || DEFAULT_TARGET) !== 'tencent') return false;
  if (cert.status === 'waiting_manual_bind' || cert.status === 'pending_deploy') return true;
  // The daemon reports an unfinished binding set as complete:false, which is
  // where a certificate sits until its first CLB listener is attached. Some
  // payloads omit the flag, so "not issued with zero bindings" counts too --
  // same situation, and the same thing for the operator to go and fix.
  const count = clbBindingCount(cert);
  if (count === 0 && (cert.status === 'not_issued' || (cert.deploy?.enabled && cert.status !== 'ok'))) return true;
  return Boolean(state.live && cert.bindings && cert.bindings.complete === false);
}

function copyButton(value) {
  return `<button class="copy-value" data-copy="${escapeHTML(value)}" aria-label="Copy ${escapeHTML(value)}">${escapeHTML(value)} ${icon('copy')}</button>`;
}

function accountOptions() {
  const byUIN = new Map(state.accounts.map((account) => [account.uin, account]));
  state.certificates.forEach((cert) => {
    if (cert.uin && !byUIN.has(cert.uin)) byUIN.set(cert.uin, { uin: cert.uin, name: cert.uin });
  });
  return [...byUIN.values()];
}

// A readable identity for an account: the display name the operator chose,
// otherwise the UIN itself. The daemon stores "auto:<name>" as the UIN of an
// AK/SK account connected without one, and the auto-generated defaults
// ("account", "account-<uin>") are placeholders rather than chosen names --
// show the bare value instead of internal placeholder syntax.
function accountLabel(account) {
  const name = String((account && account.name) || '').trim();
  const uin = String((account && account.uin) || '').trim();
  const autoUin = uin.startsWith('auto:');
  const autoName = !name || name === 'account' || name === `account-${uin}`
    || (autoUin && name === uin.slice(5));
  if (!autoName) return name;
  if (autoUin) return uin.slice(5) || name || 'account';
  return `UIN ${uin}`;
}

function renderUINMenu() {
  const counts = new Map();
  state.certificates.forEach((cert) => counts.set(cert.uin, (counts.get(cert.uin) || 0) + 1));
  const unassigned = state.certificates.filter((cert) => !cert.uin).length;
  $('.uin-menu').innerHTML = `
    <button data-uin="all">All UINs <span class="count">${state.certificates.length}</span></button>
    ${accountOptions().map((account) => `<button data-uin="${escapeHTML(account.uin)}">${escapeHTML(accountLabel(account))}<span class="count">${counts.get(account.uin) || 0}</span></button>`).join('')}
    ${unassigned ? `<button data-uin="">Unassigned UIN<span class="count">${unassigned}</span></button>` : ''}`;
  $('#uin-label').textContent = state.uin === 'all' ? 'All UINs'
    : (state.uin ? accountLabel(accountOptions().find((account) => account.uin === state.uin) || { uin: state.uin })
      : 'Unassigned UIN');
}

function renderBindingMenu() {
  const counts = new Map();
  state.certificates.forEach((cert) => {
    const id = targetOf(cert);
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  const menu = $('#binding-control .uin-menu');
  if (!menu) return;
  const ids = ['tencent', ...(counts.has('none') ? ['none'] : [])];
  menu.innerHTML = `<button data-binding="all">All bindings <span class="count">${state.certificates.length}</span></button>`
    + ids.sort((a, b) => targetLabel(a).localeCompare(targetLabel(b))).map((id) =>
      `<button data-binding="${escapeHTML(id)}">${escapeHTML(targetLabel(id))}<span class="count">${counts.get(id) || 0}</span></button>`).join('');
  $('#binding-label').textContent = state.binding === 'all' ? 'All bindings' : targetLabel(state.binding);
}

function renderCloudMenu() {
  const counts = new Map();
  state.certificates.forEach((cert) => {
    const id = cloudOf(cert);
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  const menu = $('#cloud-control .uin-menu');
  if (!menu) return;
  menu.innerHTML = `<button data-cloud="all">All clouds <span class="count">${state.certificates.length}</span></button>`
    + [...counts.keys()].sort().map((id) =>
      `<button data-cloud="${escapeHTML(id)}">${escapeHTML(cloudLabel(id))}<span class="count">${counts.get(id)}</span></button>`).join('');
  $('#cloud-label').textContent = state.cloud === 'all' ? 'All clouds' : cloudLabel(state.cloud);
}

function filteredCertificates() {
  const query = state.search.toLowerCase();
  const result = state.certificates.filter((cert) => {
    if (state.uin !== 'all' && (cert.uin || '') !== state.uin) return false;
    const status = statusInfo(cert);
    if (state.status === 'ok' && status.dot !== 'ok') return false;
    if (state.status === 'attention' && status.dot === 'ok') return false;
    if (state.status === 'not_issued' && cert.status !== 'not_issued') return false;
    if (state.status === 'expiring' && !(cert.daysLeft != null && cert.daysLeft >= 0 && cert.daysLeft <= 30)) return false;
    if (state.status === 'bindings' && !bindingIssue(cert)) return false;
    if (state.binding !== 'all' && !targetMatches(cert, state.binding)) return false;
    if (state.cloud !== 'all' && cloudOf(cert) !== state.cloud) return false;
    return !query || [cert.name, cert.uin, ...(cert.domains || [])].some((value) => String(value || '').toLowerCase().includes(query));
  });
  result.sort((a, b) => state.sort === 'name'
    ? a.name.localeCompare(b.name)
    : (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
  return result;
}

function renderRows() {
  const visible = filteredCertificates();
  $('#inventory-count').textContent = visible.length;
  $('#clear-filter').hidden = state.uin === 'all' && state.status === 'all'
    && state.binding === 'all' && state.cloud === 'all' && !state.search;
  // A certificate that has no UIN yet leaves the account count at zero, and
  // "across 0 UINs" reads like a broken counter. Drop the clause instead.
  // Count the UINs that actually own a certificate. Counting connected
  // accounts instead would report "across 2 UINs" for an inventory where
  // nothing has been assigned yet.
  const uinCount = new Set(state.certificates.filter((c) => c.uin).map((c) => c.uin)).size;
  const scope = uinCount > 0 ? ` across ${uinCount} UIN${uinCount === 1 ? '' : 's'}` : '';
  $('#inventory-footer').textContent = `${state.live ? 'Live inventory' : 'Disconnected'} · ${visible.length} of ${state.certificates.length} certificate${state.certificates.length === 1 ? '' : 's'}${scope}`;
  const grouped = new Map();
  visible.forEach((cert) => {
    const uin = cert.uin || 'unassigned';
    if (!grouped.has(uin)) grouped.set(uin, []);
    grouped.get(uin).push(cert);
  });
  $('#certificate-rows').innerHTML = [...grouped].map(([uin, certs]) => `
    <tr class="group"><td colspan="6"><button class="group-toggle" data-group="${escapeHTML(uin)}" aria-expanded="${!state.collapsed.has(uin)}"><span class="group-chevron">${state.collapsed.has(uin) ? '›' : '⌄'}</span><span>${uin === 'unassigned' ? 'Unassigned UIN' : `UIN ${escapeHTML(uin)}`}</span><span class="group-count">${certs.length} certificate${certs.length === 1 ? '' : 's'}</span></button></td></tr>
    ${(state.collapsed.has(uin) ? [] : certs).map((cert) => {
      const status = statusInfo(cert);
      const bindings = clbBindingCount(cert);
      const bound = bindingState(cert);
      return `<tr data-name="${escapeHTML(cert.name)}" class="${state.detailOpen && state.selected === cert.name ? 'selected' : ''}">
        <td class="cert"><div class="certificate-cell"><span class="certificate-mark">${icon('certificate')}</span><div><button class="cert-link" data-action="view" data-name="${escapeHTML(cert.name)}">${escapeHTML(cert.name)}</button>${certificateIdLine(cert)}</div></div></td>
        <td class="domains-cell">${domainsCell(cert)}</td>
        <td class="status"><span class="status-pill status-${cert.status === 'not_issued' ? 'neutral' : status.dot}">${icon(status.dot === 'ok' ? 'certificate' : cert.status === 'not_issued' ? 'clock' : 'alert')}${status.label === 'Active' ? 'Healthy' : status.label}</span><span class="sub binding-state tone-${bound.tone}">${escapeHTML(bound.label)}</span></td>
        <td>${bindings ? `<span class="binding"><img src="data:image/png;base64,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" alt=""><span>${escapeHTML(bindingSummary(cert))}<small>${escapeHTML(bindingsCaption(cert))}</small></span></span>` : '<span class="unbound">— <span>No bindings reported</span></span>'}</td>
        <td class="expiry-cell ${cert.daysLeft != null && cert.daysLeft <= 30 ? 'expiry-attention' : ''} ${cert.daysLeft != null && cert.daysLeft < 0 ? 'expiry-expired' : ''}" title="${escapeHTML(expiry(cert))}">${cert.daysLeft == null ? '—' : cert.daysLeft < 0 ? `${Math.abs(cert.daysLeft)} days ago<span class="sub">Expired</span>` : `${cert.daysLeft} days`}</td>
        <td class="row-actions"><button class="menu-trigger" data-menu="${escapeHTML(cert.name)}" aria-label="Actions for ${escapeHTML(cert.name)}" aria-haspopup="true">•••</button></td>
      </tr>`;
    }).join('')}`).join('') || `<tr><td colspan="6"><div class="empty-state"><strong>${state.certificates.length ? 'No matching certificates' : 'No certificates yet'}</strong><span>${state.certificates.length ? 'Try a different UIN, cloud, binding, status, or search term.' : 'Create a certificate to start building your inventory.'}</span></div></td></tr>`;
  document.querySelectorAll('#certificate-rows tr[data-name]').forEach(row => {
    const cert = certificateByName(row.dataset.name);
    if ((cert?.deploy?.target || state.deployment?.target || DEFAULT_TARGET) !== 'tencent') row.cells[3].innerHTML = `<span class="binding">${icon('link')}<span>${escapeHTML(bindingSummary(cert))}</span></span>`;
  });
}

function domainRows(cert) {
  return (cert.domains || []).map((domain, index) => `<div class="domain-row">${icon('globe')}${copyButton(domain)}${index === 0 ? '<em>Primary</em>' : ''}</div>`).join('') || '<p class="empty-detail">No domains recorded.</p>';
}

function bindingRows(cert) {
  return (cert.bindings?.items || []).filter(isCLBBinding).map((binding) => `<div class="binding-row"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAkgAAAGnCAYAAABM5KhlAAAACXBIWXMAAC4jAAAuIwF4pT92AAAgAElEQVR42u3dX5LjSGLf8R/LvTs7dmiLWklhh2W5uMEDFNsvfGzMCZrzzohCn6DYJxj2CYY8QYMR/T6sEwzqsZ6GPECFSMsRtqSVtmjLmp3VeuAHJKrJ+sMiQYBIZH4/ER0zszt/miAq+UUikWwkSSIAyKNxqZaklvnLYO3/Ch78rW8K/M8uJS3W/nom6c78+SL7/5KxYt4hALnHNwIJwA4B1JHUfPDH05q8jLkJqCykYkl3yVgz3mEABBKAXUIoMH9sqdhZH1tls1Gx+eOMcAJAIAH+xlDH/ApUr9mgY5krnXGaSYqJJoBAAuBeEGUhlMXQGUcll2ulM01ZNN1xSAACCUD9gqgnP26TVWVugikmmAACCYB9QdRaC6JA3C6rMpimkqbckgMIJADVRFFHUmiC6JwjYp2ViaXYBBOzSwCBBKCkKOrp8ywR64jq5UqfZ5eIJYBAAlBQFPXErTNiCQCBBHgcRdnts56YKfIilpKxIg4FQCABeBxFTRNFoVhT5KNszdKIBd4AgQTwA5jeQgslveVowFhKGkmKuAUHEEiAT1HUlDQwYcQtNGwzMaEUcygAAglwNYw6JowuOBrY01zp7beIQwEQSIArYdQzYcSu1jjUSunttxG33wACCahrGIWShuI2GsoxkTRMxlpwKAACCbA9irL1RQOxbxEIJYBAAggjwgiVujahFHMoAAIJIIyAx6E0YD8lgEACqoqjIWEEi3HrDSCQgKOGUSgWX4NQAggkAFLjUoGkiDBCDbE9AEAgAYWHUcuEEfsYwYVQGrDhJEAgAYeEUVPprbRLjgYcMzehFHMoAAIJ2CeOQqW3JFiADZdNTChx2w0gkICtYdQxYcTtNPhipXQR94hDARBIwMMwyvYz+oajAU/NJYXsnwQQSEAWR4F4Og3IjJXOKHHbDQQS4GkYsQgbeNpS6WxSzKEAgQT4FUc9pbNGLMIGnsdsEggkwJMwYtYI2A+zSfDSCYcAHsVRIGlGHAF7OZP0vfnuQcCfzwxmkOBJHA3FE2rAoeaSenyvGwgkoP5h1JI0lXTO0QAKwdeVgEACah5HLMQGysMu3HAaa5DgahyNJH1HHAGluZAUm93nAfc+R5hBgmNh1BK31IBj4pYbCCTA8jgKTBwxawQc3yQZK+QwgEAC7IqjgaRvORJApeaSAtYlgUACqg+jpqSR0vUQAKq3MpHEl96CQAIqjKNYrDcCbPSOdUmoM55iQ13jqCNpQRwB1vponiYF6vk5wwwSahhHodLbaizGBuzHfkkgkIAjxdFHjgRQKyzeRu1wiw11iqOIOAJq6VxsKom6feYwg4QaxRFPqgH1xhNuIJCAgsKIJ9UA9yKpl4wVcyhgM26xgTgCcEynkr436wkBAgkgjgCs+UgkgUAC9oujFnEEEElApZ9FrEGCZXHUMXHEHkeAP9h1G9ZhBgnEEYCqMZME+z6TmEECcYQSzKX7TQHjtf99YX7tqylt7KHTMf9bU9yKdQkzSSCQAOKo1laSZmvBM5N0V+Wj241LBeZPg7Wg6nBeEUkAgYQ6xlHTfLiecTSstTTv0cyE7CIZ55oFqvIc65hwyqKJ841IAggkWP3BFYtbJLa5Xouh2MXvzzLnXrAWTm9424kkgEACcYR187UYmnp8TgaSeiaYOC+JJBBIBBKIIw9dSZqaKFpwOB6doy0TSj1JbzkilXrNd7eBQIIvHz5TPnSObmWCaOrzLNEB52zPxFJPLPqu4tzlC25BIMH5D5pI0gVH4miuJEVEUeGxFBL5RBIIJKCoD5ahpG84EqWbSxopnS2643CUdj43lc4oDcTt4mOd1wHnNAgkuPZhEkr6yJEo9Qp7KmnEVXYl53fHhBK34IgkEEjAzh8egaTvORKlWEoaitkiW871ptLbbwOx11JZJsmYryUBgQQ3rqxjrqoLd610toi1Rfae+9ntN/ZYKt6HZKwhhwEEEup8NR2L9RlFujJhFHMoavNzECid5SOUisUeSSCQUNsPhpgPhcJMJA3Zs6jWPw/ZOiWe4iwGT7aBQEItPwxGki45Ege7lhQSRk79bARiRqnISGqx/g4EEuryARCKJ9aKCKMht9IIJbxonozV4TCAQILtgz6Lsg+zlDRg8bVXPzM9pftW8dRbfuNkrAGHAQQSbB3om0q/BZ6Bfn8rpYuvhxwKb39+hkrXKHFxkQ+LtlGoEw4BChQRR7lMlK6jII48Zt7/jtInFbG/kZnBBoq5aGEGCQVd/Q4kfcuR2MtS6QLsmEOBBz9PARccubDTNggkWDWYdyT9wJHYCxvdYZefraH4/sJ9sdM2CCRYMYCz7mj/K9yQvVuw5wVIJDZc3cfXPOgAAglVD95TSW85Ejth1giH/KwNxWzSrlaSOuwfhkOwSBuHDNghcbSTpaTXxBEOYc6f1+Z8wnanEk+0gUBCNXHUUrp3C7abmCtZbqmhiEiaKX3SbcLReNEbM+sG5Puc4xYbcgZSLHYA3maldMNHrmJR1s9gaC5S2Ddpu9dcoCAPZpCQZ2AeEEdbZY8aE0cojTm/AnO+4Xn8HIJAwlHiqCP2O9pmIr5hHMeLpJmJJG65Pe+cW23I9XnHLTbsGUgz8bjxc94nY9ZlobKfTTZr3Y5bbdgLM0jYdwAmjh5bSfqKOEKVzPn3lTkf8VjEIQCBhDLiqCUxTf2EbL1RzKGABZEUK33KjXVJj3GrDQQSSrv64mmZp+OIaXvYFEkLpeuSrjkaj3xjLvYAAgmHM48T89TapmwxNl+KCRsj6S4Zs3h7y8Ue8PJnH4u08UIcNSUtxOzRRhzxZZio0c9wJOmCI7HhHdtw4CXMIOElQ+JowwfiCHViztd3HIkNI3PxBxBIyHXl2ZF0yZHYuOocchhQw0iKiKQNp+KhExBIOOQqi0OwEUcRhwFEkjMuzUUgQCBhdyzMJo5AJHERCK8/B1mkjSfiqClpJumMo0EcwdkLoI8cCUnS18lYUw4DHmIGCU8ZEEfEEdzFTNIGZpFAIGGnK8uWCSTiiDgCkeSDM3bYBoGEXQzFY/0T4ghEklcGPPYPAgnPMrNHvm8oxyaQ8DGSPnh+GE7FzDkIJGwRef76r4gjeBpJQ/G1JHxPGwgkPNa4VCC/H+ufS8QRvI6kUNKV54dhyJkAAgkMDJ+txBfPAjIXCXOPX/8Fs0ggkHDP89kj4ggwzM9BYH4uuFgEgQTv+TwgDJKxZpwCwKNI8hWzSCCQ4P3s0ZjH+YEnI2kmvx//H3IWgECCrwPBdTLmsV5gSyRF8vfJNmaRQCD5zOPZo6WkHmcA8GIkhfJ30faQM4BAgr98nUHpsSgb2P3nRX4u2r5gd20CCR4y08dvPXzp71mUDewuGWshf/cI4zY8gQQPDT18zdfJmG/uBnJE0lTS2MdAYhaJQIJHzA+8b9+5thLrjoBDImkg/9YjnYod9gkk+HVV5OFrDll3BBz+cyT/1iNxm41AAj/wzroytwgAHMCs3xt69rLPGpfMPhNIcF7jUqHSaWNfrMQUOVBkJI0kXXNRCQIJ/KDXG7fWgBJ+ruTXrbY3bBxJIMFhjUt1JJ179JK5tQaUwDz6P+TiEgQS+AGvH26tAeVG0kh+PdUW8sg/gQQHmR9snxYaDrm1BpQfDR691lOxVQiBBCf15M/i7DkbQgLlM0+1+bSBZMi7TiDBPQNeK4ASDOXPgm0WaxNIcIn5gfZlcfYkGSvmXQeOw9zK5gIMBBL4gbbYSn5+xxxQdSRF8mfBNuuQCCTwA107I/P4MQAuxMrCztoEElxgfpDPPHipK4mF2UBVzK1tX3bYJpAIJPCDXJ+rVx7rByoXevI6A95qAgkEUh0szRoIABUyt7gnHrzUGe+2+15xCNxlbq/5sPfRkHcbsOrn8aKC/252e29hfj38c0m6M3s37TOOdqRHO2gTSD58hiZJwlFwN5CiigaqY1omY/YlATwYe+aS7iTF5o+zPMED7IoZJLf5cHttyNsMWPlzmTeQlkpnfWITQQsiCJWEPjNIzl7B9SR95/jLZPYIsHcMinaIpJWJoCyGYh62gC2YQXKXD7NHPNYP2Gv4RCCtTAzFJoaYGQKBhKMLHH99K4kn1wBbJWMtGpf6rdINJBcEEeqGW2wuvqnpUxc/OP4yPyRj1h8BAMrBPkhu8uH2WsTbDAAgkEAgfTbhO9cAAAQSdta4VFPSueMvM+KdBgAQSNiH67NHS/OlmAAAEEjYWeD46+PRfgAAgQQC6YGItxgAQCBhZ41LtSSdOfwSJ+yyCwAgkLCvwPHXN+UtBgAQSCCQPlslYwIJAEAggUBaRxwBAAgk7MeD9Uc8vQYAIJCwt47Dr23Jl1wCAAgk5BE4/Npi3l4AAIGEPFyeQWL9EQDgqBpJknAUXHgjL+XqG7lKxmryDgMAjokZJDfiyOXZo5h3GABAICEPbq8BAEAgwaNAinl7AQAEEgikz+bJWAveXgAAgYQ83jj6umLeWgAAgYS9mR20XUUgAQAq8YpDUHv7B9Kf/dty46//8g+v9Iuf/7TTP/tvJ6/0T7+SEn3++//PL8r6ihMCCcBuF4ufNjbLDR783x1pr+1CZpLu1v56YX5J0iLpc+ufQEIdBI/i54v/d6Lf/PSz/v2ffq2/+OnPJUn/8cf1v6u872z7+y/TP/7TF7/Xv77637r74gv9+O9+yhFR82S8MUAB8DuAOuaCMIud7I/nJfzn3rzwe8lcr13M3ZmwIqBcOefYKLJmb9jNbccMDC1Jgf7lF/9N//fVn+nPf5J++bPdv/k/nki//yKNp9/96o9a/fIPW8JpkowV8o4D3oVQFj/B2lh3XsOXcq101mkmaZb0mREnkFBkDDXXBolAri7G/v0X0v/68g/6+y//Ub/71a/1x5NTSe+SsSLOAsD5IMrGt2ysO3P45c5NMMWSYmaaCCTsH0TZr3MvD8QfzbMDv/z52gwk06TbnnGGAM4FUSDp1OPDscxiiWAikPA4irLBoid3H9cvwkrprtpZMLE+CahHEDXXxrhAbs8QFRFMUxNLfIsAgeRlFGWDRY/BIrer+4Gk2+aqC7AvirIx7i1HJPdFYWzGuWnS56EVAsndKOpIGpgB45QjUkosMbMEEEXuj3PEEoHkQBS11qKImaLjmJhQYnoaOE4YBZJCLv6OZrUWSoxzBFKtoii7igrFmqIqLSVFkiJuwQGFR1HTjHEDLv4sGedY4E0gWRxGLTNYhFxFWWdiQinmUAAHhVG2VOCCo2GdKxNKzCoRSNaEUSBpKGaL6mAuaZR02xGHAtgrjHomjBjn7LeUNDKxxFolAqmSMApNGDG9XOcBhEXdwLYwYpyrr5UZ50aEEoF0jCjK1hcxYLg2gBBKAGHkromkIeuUCKSywmhgfrG+iFACCCMQSgSS93HEgOFXKA2TbnvEoQBhBEKJQOIoEEbYtDShFHEo4HgYBUpnT885Gl5eELJGiUDaK4wC8VQaUtcmlGIOBRwLo5bS/XMY55DOnPfFzDmB9GwYtUwYsb8HHpqYUFpwKFDzMMrWU37D0cADS0lh0hcXhATSRhwNxQJsvHyVNUq67SGHAjWNo57SWyosG8A2V5IGrE/yPJDM7bSIAQN7mEsacNsNNQqjlridhjwXhH15fUHoZSCZx/aHki75OUBOY6W33VjcCJvjaGDGOmbHkfeCMEz6mhFIfsRRz1xNMWDgUEuls0l89xFsC6OOGed4Og1F+ODjbJI3gWRmjSJJbznXUbArSSGzSbAkjgaSvuVIoGDezSZ5EUisNcIRLE0kxRwKVBRGLbHWCOXzZjbJ+UBq3NyOxFojHM846bYHHAYcOY5CpU+osXQAx3CtdDZpQSDVM4xakqbiHjyOL52K7rZnHAqUHEZNE0bs34ZjW5lIcnYN5omjcdSTNCOOUJFzSbH5uhqgrDjqSIqJI1TkVNJ3jU/u7sDt3AwSt9RgmYnSJ91YwI0i4ygUt9Rgj7mknmu33JwJJPOUWixmjWDn4MEtNxQVR5GYNYJ9ViaSYgLJrjjKppq5moLNg8cg6bYjDgVyhlFLrKuE/d678sW3tQ8ks86DqWbUxSTptkMOA/aMIy4CUa9xrq/aj3O1DiTzJbN8KzXqZi4pYF0SdoyjUNJHjgRqOc71VdtxrrZPsTVubiPiCDV1Lmlhbg0D2+IoIo5Q43EuNrOf9fz5q9sMEoux4Zh3rEvCE2HUVLreiF2xUXcrpTNJtXtIpVYzSMQRHPTRzIYCWRy1zDhHHMEFp0pnknq1+1msywySuR0REUdwFOuSwGJsuO5d0ldtLghrMYO09hg/cQRXnUuasS7J6zgKiSM47qM5zwmkguOIQQOuO1P6FSU9DoV3cTRQuhibcQ5EEoFEHAFPSL/fKN3CAn7EUSTpW44EiCTLfjZtXYNEHAFsKul4GDWVbnLL14bAV1avSbIykIgj4B6Lt92No1isqwSsjSTrbrERR8AGFm+7F0ct4gi4Z+3tNqtmkMw+RzOli1UBfLaSFCbd9pRDUes44gIQeJp1M0nWBBKbQAI7DiLsvE0cAW56bdOO21bcYiOOgJ2x83Y94yiU9ANxBGxl1Xe32bIGaUQcATu7aNzcTs2FBeoRR3zhLPCy7GtJWgSSpMbNLY+5Avt7q3RTSSLJ7jgaEEfA3pE0NU96+htIjZvbUNIl5wOQy7mkBU+4WRtHkdgAEsg7tlX+QEplgdS4uQ24sgIKudri60nsjCNmxoH83pifo+p+jqt4iq1xc9tS+jg/CxaB4vCEG3EEuDeuVfT4/9EDiSfWgFKNk257wGGoJIyaSm8LvOFoAIWq5PH/Km6x8cQaUJ5LtgGoLI5i4ggoRVzFou2jziA1bm4HYtGiTVbSRpXHO/wzwdqf82FgL77D7fhxxIWffa73HN860v0HcUt8q4NV72XS3/j8cSeQzJM2P/AeVxZBM0mL7I9Jt70o8L0NzKDSWfvFwGJHJPWKfK9BHFlouTbGzSTdJf2dYmif97hjgqnFGFepD0lfQ6cCie9YO/oVU5wNFlV9OJr3PFj7xQdIdYEcJN32jENReBx1JEWc25WE/9SMcXHS112F50A2vnXMH3nwqHxfFRnANgRSJJ7qKHOwiCVNk247tvU3uRZMPfOLgeS4kcQX3RYfRzHn8dHO36n5VWkQ7XheZNH0lreutPOhdYzzoPRAMvuzfMd7WngURSaKFrX8gEnPC2LpuNgGgDiqXRQlfU1rep5wUVieq6Sv0vd+KzWQ2O+IKNojlkKuuI6CbQCII6s/+CRFdY2iF84dxrlivU/6GtU5kGLxpFMRV1EjH9aQmKAOzS/Wq5VnknTbIYeBOLJonBuZMFp4cB41zRg3YJw7+LzplHnOlBZIPNJ/kOX9gOHpY9rme/oGYgFsWa6VPuHGNgDEUZXj3FDpbbQ7T8+rnhnnmEjIOY6V+eh/KYHErbXc5kpniyIOxf25FJhBlAGknPONvZJe/hALzQUL41mBYVTV10dYeo61zDjHw0z7K+1WW1mBFPOBtvcH1cDmp9AIJac/rHpsA7A1jvhSbcKIULJXabfaCg8kc2uEAWWfAYMZo33Or565mufefbEDDHslEUdlnl/DshfUOhhKEReEOyvlqbZCA8nsdbMQU9G7DRjdNgNG/nNtYK60ONeKOycHxDpxVLCxiSNu4+Y7DwPx/aW7+rropx+LDqRITA2+ZGI+iBgwignyoaRLjkZhvN8riTgqxLWk0Ien0o50TnJB+LKl0ltthX22FhZIZo3I97xHW9+8kHVGpYQSX/lQ8FW/r3slEUcHS2ciWWdUxrnZNOMc+yg9r9DvaisykGJxv/T5N63bHnIYSg+lodJHZrnKOpx3eyURRwe7UjprxOx4uedpz4QS49zTflvUzGUhgcTC7Gcxa3T8SGqJxY1F8WavJOLoICsTRnzX3/HOV2aTtoxbRe2NdHAgmXUgM/FU0aMrcLHWqMpQGkr6hiNxMOf3Smp80kisYzskollrVN25y9qkp32V9BUf+i85KeA3wnbpj6+m3iXddkgcVcfc0nxtPuCR37mk2KzzcvEDJiKOcvuQ9BUQRxWOc+nWCQHj3COFPCF+0AwSj/U/wqZ7tn0ApufoSDxdWUT4O7VXkokjzou850JfjHP2nMvccnvs3aEPCxw6gzQkju7NJXWII8uusLrtO7PY+J0Z2JHPqdKZpIA48tq1pBZxZNk419ed2SjxA0djo08OGyfyziCZxbB/y3sgiW9Hr8eHItsBFHdlVuO9koij3MZJXwMOg/XndygeOPg8Vh0wi3TIDNKQYy8pfYSfOKrDVVY6uxcofRwZ+X00T64SR35YmQ8a4qgO41waBK/FjPnBnZJrBonZIzeupL2+yrq55cmlw9Vq5pQ4yh1HrDeq58VAR1IslsHknkXKO4M05PQjjmp9lZXuFP2OI3GQC/P1QsSRm9J1lcRRPce49H0LxBNuuXtl7xkkZo+II6eustJ1SVxlHRabDYvDiKd78sdRwK7YDoxx6c9ALL/XXuaaRcozgxQSR8SRQx/uM0kdrrKc/mAgjvYzSfrFfuknKhzj0vcxULoNja+Gef6hvQLJ7Cnj80I94sjNSFqIxdu5P0y5anYujkIOg5OR1JO/C7fPzNN95QWS0tkjX29FEEduR9Jd0m33bP3At/bD1MJF2sRRbh+II6cjKVuT5Gsk7X1u77UGqXFzu5CfXyvCPkce4cuXiSMvLwAP3HUYNRnf0qfbfvD05e/1HW07zyCZDw0f4+iKOPLsSiudKfxa7CPy/EwDcUQcoZ7jWzqT5OsTvHuNWydl/YsdMReL0n2NpKn8no5+/sM0/SJg4qj+VpJeE0deRlIkaezhS79ofFKr0EAyj/a/8XDw6CXdNk9y+BtJM0kt8YTbehxZ92FKHOUe39gA0u9IGsjPB1PCQgNJfj651jNPN8HvSMoekfX9CTdb46hFHBFHOCgWlh6+5kIDKfTsAH5Iuu2Ynx1kkeT5E262xlFH0ow42gu7Y+Pz2Pb58X+fnDU+7faaXwwkszjbp0f7r21cYwErQimU9J44siaOYrED+r5xFCR9LTgUWIukmYfjWjGB5FldrsSibGyPpJHSJ0B8WLxNHLkXR6ypxFORNJJ07dFLvjBrF/MHklmc7dM2/QPWHWGHSIrk/hNuxJE7rogj7MC3nbZfnPw5OfRf4NIgwk7Z2COSXP6mbOLIHZOkrx5xhBfHtPQcCT16yS8+fPZSIPlysFby+zvmQCQRR27GUchhwB6RNJU/t9rOX9oT6dlAMrfXfHk6ZMitNeSMpGwbgLo/4baS9DVxRBzBe6H8udXWyxVI8uf22twsvAVyR5J5wq2ukZTui5PuHm5bHAXE0d7GxBFyj2fpU46+fCaGeQPJlx8wbq2hqFAKVb/vOMriyLp9cRqfFEr6njjayzuzQzJwSCQN5ccGkltvsz0ZSB7dXpuwISQKjqRI9dkGwPY4+sgZtXccRRwGMHmwl95egaR0TYUPhvwMoKRICiyPJOKIOAKeH8f8WbAd7BtIPqw/mrAwGyVGks1PuBFHxBHAJELq7XObRvo6g8Rj/fA1kogjt8axr4kjlDaG9RXL41mkR4HUuLkN5P6iyMg8ng2UHUk2bQNAHLkVR4G5DQKUaejBa+ztFEjy4/Yaj/XjqJFkwTYAxJF7cTTjUKD08cuPWaRg10AKHD8QrD1CVaEUqpptAIgj4gg4xNDx13f21OP+G4HUuLltyv3H+4ec66gwkqIjR9Lc4jiKiCPiCDUYt9JZJNf3RQq2BpLcnz26ZvYIlkTSa5W/DYDtcXTB2UAcgckFAskOrD2CLZGUPeFW1lVZFkfWPYxAHBFHqKWp3P6OthcDqePwi1/a+F1T8D6SOip+GwDiyB1zSS3iCJWPV33dmUhy1aN1SA8D6Y3j9QvYFknZNgBFPSVCHLkVR4H5YAJs4PpdmM6TgWT2P+KNBSqIpKTbDnT4NgDEEXEElDdWpTOZc4df4tOBJLdvr81ZnI0ahFIoaUwcEUfEESwWOfzaAh8DKeKcRk0iaaD9twEgjogj4FhcXq7y7AxSizcUsCKSIhNJuzwxYmUcNT6p2fikmDgijuDY+NTXQu7eZjtdX6i9HkiuLtDm9hrqGknBC5FkbRxJiuX2Qx/EEXzmxSzSiSQ1bm5dvr0Wcy6jppG0ba+kK8vj6Jx3kDgCgVT7QBK31wCbI+nhXkmTpNvuEUdOuCKOULtxKX2azdWvHrkPpFcP/wfHrJJuO+Z0Rs0j6c5sw9Exf23dOU0c5TJJ+go5DKipWG6uMWz5EkjEEZyJJFvPZ+KIOAKB5JD7cSy7xdZ09A1ke36AOCKOgHICydVxrbUeSG94AwEQR8QRsAvzuL+r65A2AsnNN5D1R0BZcdQhjogjeM/VuzRpIDn8HWxzzl2AOCKOAAIpVyDxxgHIEUenHA3iCN6LXQ8kV59gW3DuAsRRxcbEERzm6ufsfSC5+gRbzLkLEEcVepf0NeAwwFVmobazXA6kBacvQBxVGEcRhwEeuHbwNb3JAsnJW2x8QS1AHBFHQOmc/ZocVxdp8wQbQBwRR0D5nH0gytVA4osfgcPiqEccEUeAr5+3jU8KXL3FtuCcBXIPDKGk74gj4gjYgdMzSC4OggQSkD+OPnIkiCPAdyccAgDEEXEE5LQgkOqFNUgAcVSmlaSviCP4zuG9kJqvHH1hfM0IQByVGUdB0mecARzW4RYbQBwRR8QRgAcIJIA4AnEEgEAC0PikAXFEHAF43isOAeBdHEWSLjgSxBGA5zGDBBBHII4AEEgAcQTiCACBBBBHxNG+lsQR4DfWIAHEETbNTRyx4SzgMVdnkFq8tQBxRBwByGlBIAHEEYgjIO844+rn7YI1SABxBOIIyMvVQHJ2DVKLcxaehlFTUizpnKNBHAHI70TSNYEEEEfEEYAcOi4HkouanLMgjkAcAXze5jRzNZD4kABxBOIIKF/LxWfZ7aYAAA0rSURBVBeV9HV3Imnh5IfGzW2L8xbEEZ4wIY4AAuklr1wNJPOmLTh3QRxhPY6SvkIOA1AYF9cgzSW3v2qkw3kL4gjEEVDqOHTq4Eu7ywIpJpAA4og4AsDn7GYg8cYB9YmjjtJbx8QRcQRULXD0dc2yQHL126r5AIGLcRTLzSlt4gioH7dnkJJu29knORo3twHnL4gj4ggAgbSH+xkkyc3dtF1+80AcgTgCqhyXWpLOHH15G2uQXJ1FCjiNQRx55wNxBPD5mlfS35xBmvEGAsSRA94lfQ05DACfrzktsz/JAmnh6As9bdzccpsNxJE/cRRxGAAC6QALXwJJknqcxyCOiCMAhY5Rrq4/ijcCKem2YwIJsGLgCYkj4giwXODwa1tsBJIxd/TFnvPFtahRHH0kjogjwHKhw69t9lQgLRx+wcwioS5xBOIIsHmsasnhjZizJ9geBtLM4fc05LQGcUQcATiYyxMOG3tCrgdS7PCL5jYbiCPiCMDhQodf2+zJQHJ8obbrbyqIIx+sJL0mjoDKxqyW3P6e06cDyZg7/MIJJBBH9Y6jYH19AICjGzj++rYGUuzwCz/jy2tBHBFHAHILXR5nHo4xJ9vqifoFCo+jIXFEHAE1vbBzeQuS+OH/4NMMkiS9ZbE2KhxgIknfcCSII6CGQsdf3/ZASrrthda+qM1RzCKhqji64EgQR0ANx69A0huvA+m5v8m1Cm7c3DY55UEcEUcAdvvcdH3MeWq8eSqQpo4fiFMxiwTiiDgCsMsY1vJgDIuf+h99nEGSpAGzSCCOrDMnjgDrDD14jdOdAinptu/0YLttBzGLBOKIOAKwfRxreTKOxTsF0raacgyzSCCO7IqjOw4FYJWRD+NP0tdin0CKPTgop/Jj6hDHC6MmcUQcAY6MZ4Gktx681GcnhJ4MpKTbnsn9x/0l6ZJ9kVBUHJkLC+KIOAJc4MsEwn6B9NI/5JiInwMUFEfnHA3iCHBgTAvl/r5HkrTctu7xhHDQG76jDcQRcQTgfkwbefJyt04EPRtIHt1mk6SIBdsgjogjABrK7e9c2/jszxVIu9SVQ87Egm0QR8QR4Pe4Fki69OTlLl/aVuSlQIo8OjcuudUG4qg0k6SvDnEEWD2u+fSZ/+Jr3RpI5jbb3KcDxq02EEelxFHIYQCsNlR6N4VA2iWQdv2XOIRbbdgWRy3iiDgCHBzbAvlza03asjkkgbTdZePmtsePDB4MIB1JM+KIOAIcG9ua8me9cWanp/ReDCTz3WwTzw5exAaSeBBHsfx5soM4Avwx9WxsW+0ahCc7/gsjz06YU0lT1iOBOCKOAIfHt6H82BByIwh3fVhkp0BKuu1Y/uyJlDmXP5tlgTgijgC/xreepG88fOk7f66flPEvdchF4+Z2wI8ScQTiCHBsfIs8fOnXL+19lDeQIqX37nzzLYu2iSO86D1xBNRifMsWZfs4vu0VhTsHklmsPfX0nIoaN7cdfrSIIzzpXdLndjRQkziK5dd+R5ll0i8pkIyhp+fVqaSYSCKO8GQcRRwGoB4X+/J3q5K9x6m9Ainpthfy75H/h5HEk21uxlEo6QfiiDgCHB3jIklvPX35K+VYR32S4z/k84BIJLkbRx85EsQR4HAcXXh8CEZ5vgdy70Ayj/xfe3ygz4kk4og4Io4A4qg+gZTnHzrJ+R8ben6ws0hq8eNHHBFHAIgja03yzB5JUiNJknwH/uY2ln87cD60khQk3faMH0XiiDgCYMn41lQ6a3LB0dBvd/li2qecHPAfHXLc79ckBRwK4sjxCwHiCKhPHMXEkaR09miR9x/OHUisRdqIpO8bN7chh4I4cjSOAuIIqMX41pE0k7+P8j8cuw76JoyTA38DfA3HZx8bN7d8iBBHLsYRt5AB+8e3nvzdBPIpo7xrjwoJJLP2ZsL7cO+icXM7Y/G2lYPHiDgijgCHx7fvxD5u6+PXwbv7516kff8vSGPgb3k/Hr05YdJtTzkUVgwekbgfTxwB7o1tLaVfAcYttU3vi/j6o4MDyUTSUNI3vCePjCUNzffYgTgijgAUNbaFSmdJmDXatEz6ahXxLzop6Dc0MgMrNl1KmvGUG3FEHAEoaFxrNT5pqnTJAHH0WFjUv6iQQDIzJCzYftqZ0qfcInbfJo6IIwAHjGsDpU+pveVoPOk66Ssu7HgXcYvt/l/G5pG7fAgNk257xKEgjogjADuOaYHSOzWsNdrut4fse1R2IHWUfiM6tltKGrCImziywFxSr8hBBUBh41nLhBEzRi/7kPSL3cC60EAykTRSuvYGL7tWOqMUcyiIo4riKDh0rxAApYTRkPFsZ4UtzC47kJpK75GyWRWhdKzBpCkp4iqLOAIIIy99VeTao9ICyURSIOl73rP9K9iEUsSh2CuOYnFvnjgC6juOBUqfviKM9jdO+uU8JFZKIJlIinizc1spnREZJd32gsNBHBFHgJPjV0/pE+CMYfknFTpljWdlBhK32opxbWJpyoaTxBFxBNR+7AqUzhb1xD5Ghyrl1lrpgWQiKRC32op0pXRbea9jiTgijoCajVmdtShi0qAYpd1aO0ogmUjiqbbyYik2sbQgjkAcAVaNU4EJImaKilfqrbVjBhIfaMc5WeLsl6vBRBzlcq10nyPiCCg/iLJfjFHlen2MjW1LDyQTSR3zwUZFH8dK6fqv2PxxVvdoIo5ymST94r6XCMD9WNR58Itx6XgK3xCy0kAykTSQ9C3vbeWzCXcmmhbm113SbVv9FRPm/n3EIEQcAUeOoId/7HChX+1nWNJXcLTz4FiBZCIpEo/+22xuAioTb/l7Zw/+3l3M9l1cbuIoZlAijgDzBNi+tv0zWfxk+C5Re60ktY65XODYgcRtEuznH/7qR61+/SUHAgC8Vuoj/U85OeZ/zMwehKYEAeIIAPCS98eOo6MHkomkmYkkgDgCAGwzSfoaVfEfPqniP5p021NJH3jfQRwBAJ4xl8rdDHKbo65BevQfZ9E2iCMAwGNHX5T90EnFB2BgChEgjgAAWRxVvvt/pYFkFm0HSneCBnFEHAEABsfYKdvqQFqLpJ54ss1PSeNH/ff/IuIIACDpXdJXZMNv5MSG34R5si0gkjyMo7/76y/10xccCwDAxJY4siaQ1iJpwPlBHAEAvIyj0Kbf0IlNv5mk244kveM8IY4AAMRRlSp9zP/Z39TNbSjpI+cMcQQAcNo86atj42/sxMbfFDNJxBEAwP04knJ9AbG/gUQkEUcAAPfjqOq9jmoZSEQScQQAII4IJCLJTX969c9a/lfiCABQmziSLF2k/eRvlIXbNY2jv/mNfj7hWAAArHxa7Tm1+eRiJok4AgAQR8dSmxmk+9/wzW0gaSrplPONOAIAEEcE0udI6kiKiSTiCABgtXc2fX3IPmr5KWa+lqSjdLEXiCMAgF1WdY4jqaYzSPe/+ZvbptLbbW84F4kjAIA1cRQkfc3q/CJqHUhroTSSdMk5SRwBACpVm8f4X+LEJ1rSbQ+UPuG24tw8sn/5D8QRAECSJq7EkeTIDNL9i0kXb08lnXGeHimO/ud/+g0HAgC89z7pa+TSC3IqkEwkNSVFkt5yvhJHAIBSLSX16r7eyItAWgulgaRvOXeJIwBAKa4kha7cUvMmkEwkccuNOAIAFM+5W2oPOb2ydm2/pAnnMnEEADjYXNJr1+NIcnwGaeOF3tz2lK5NYvdt4ggAsL8PSV9DX16sN4FkIokF3MQRAGA/S6VrjWKfXrRXgbQWSj1JI7E26WW/b670u79g1g0A/OTVrJH3gWQiqSlpKHbgft4//NWPWv36Sw4EAHjnWtLAxcf3CaTdQ6mjdDaJ73MjjgDAdysTRpHvB8L7QFoLpVDpjBK33YgjAPDRB0kjV/c1IpAOi6SmpIH55ee6G+IIAHxzpXTWaMGhIJB2CaWRpAviCADgqGtJQ9+eTiOQigmlltLbbu6HEnEEAIQRCCRCiTgCAMIIBFKxodSTC2uUksa/6h//skEcAQBhBAKpiFCq/2LupPGj/u6vv9RPX/CGAoCbJkqfSptxKAikKmIpNKF0ThwBACq2UvqQUcRTaQSSLaHUMaFk9+034ggAXHRtoijiUBBItoZS00RSKNt25yaOAMAlS6VfwM5sEYFUu1hqrcVStbfgiCMAcMFK0tREUczhIJBciKWOiaXe0WOJOAIAF6JomvQ15XAQSC7HUsuEUiDpLXEEAHhgLik2URRzOAgkH2OpaUIp+1Xc7NLPJyv9j/98ShwBgPVWWRBJillTRCDhcTC1TCh1DgqmP736Zy3/5jf6+YSDCgD2WUqamSiK2auIQML+wdRci6WO+XVGHAFAbaxMDGVBNGOGiEBCudHUkdRa+/NT4ggAKnUt6W4thhbEEIEEG97QTwokZQElpTNPMiF1xhECgIMDSJIWD37Nkr7uODwEEuodUR0TUXoQU3oQVeuaqtPXqQDAY9mtroeyyMncPfj7iB8CCSgkwAKOAoAjumORM4r2/wG1FGcrYktsdQAAAABJRU5ErkJggg==" alt=""><div><strong>${binding.loadBalancerId ? copyButton(binding.loadBalancerId) : 'Load balancer not reported'}${binding.loadBalancerName ? `<em>${escapeHTML(binding.loadBalancerName)}</em>` : ''}</strong><small>Region · ${escapeHTML(binding.region || 'not reported')}</small><small>Listener · ${binding.listenerId ? `${binding.listenerName ? `${escapeHTML(binding.listenerName)} · ` : ''}${copyButton(binding.listenerId)}` : 'not reported'}</small><small>SNI domain · ${escapeHTML(binding.sniDomain || 'listener default')}${binding.role ? ` · ${binding.role === 'primary' ? 'primary certificate' : 'SNI extension'}` : ''}</small>${binding.protocol ? `<small>Protocol · ${escapeHTML(binding.protocol)}${binding.port ? ` :${binding.port}` : ''}</small>` : ''}</div></div>`).join('') || '<p class="empty-detail">No CLB bindings recorded.</p>';
}

function validityLabel(cert) {
  if (cert.daysLeft == null) return cert.status === 'not_issued' ? 'Not issued yet' : 'Expiry not reported';
  if (cert.daysLeft < 0) return `Expired ${Math.abs(cert.daysLeft)} days ago`;
  if (cert.daysLeft === 0) return 'Expires today';
  return `${cert.daysLeft} days remaining`;
}

function renderDetail() {
  const cert = state.certificates.find((item) => item.name === state.selected);
  if (!cert) {
    $('#certificate-detail').innerHTML = '<div class="detail-empty"><strong>No certificate selected</strong><span>Select a certificate to view its details.</span></div>';
    return;
  }
  const info = statusInfo(cert);
  const overdue = cert.daysLeft != null && cert.daysLeft < 0;
  const soon = cert.daysLeft != null && cert.daysLeft >= 0 && cert.daysLeft <= 30;
  const content = `<div class="validity-card ${overdue ? 'overdue' : soon ? 'due-soon' : ''}">${icon(overdue ? 'alert' : 'clock')}<div><span>Certificate validity</span><strong>${validityLabel(cert)}</strong><p>${overdue ? 'Renew this certificate and verify its deployed bindings.' : soon ? 'Review renewal before the certificate expires.' : cert.notAfter ? `Valid until ${escapeHTML(expiry(cert))}` : 'Validity will appear after issuance.'}</p></div></div>
    <section class="block"><h3>${icon('certificate')}Certificate information</h3><dl class="kv"><dt>UIN</dt><dd>${cert.uin ? copyButton(cert.uin) : '—'}</dd>${cert.deployedCertId ? `<dt>Certificate ID</dt><dd>${copyButton(cert.deployedCertId)}</dd>` : ''}<dt>Lifecycle</dt><dd>${info.lifecycle}</dd><dt>Expires on</dt><dd>${escapeHTML(expiry(cert))}</dd></dl></section>
    <section class="block"><h3>${icon('globe')}Domains <span class="section-count">${cert.domains?.length || 0}</span></h3><div class="resource-list">${domainRows(cert)}</div></section>
    <section class="block" id="detail-bindings"><h3>${icon('link')}CLB bindings <span class="section-count">${clbBindingCount(cert)}</span></h3><div class="resource-list">${(cert.deploy?.target || state.deployment?.target || DEFAULT_TARGET) === 'tencent' ? bindingRows(cert) : '<p class="empty-detail">No supported CLB deployment.</p>'}</div><p class="section-note">${escapeHTML(bindingsEvidence(cert))}</p>${cert.status === 'waiting_manual_bind' ? '<p class="security-note">Binding is required: attach this certificate to a CLB listener in the Tencent Cloud console. This page notices it within ten minutes and says so here, or press Refresh.</p>' : ''}</section>`;
  $('#certificate-detail').innerHTML = `<div class="detail-head"><div><span class="detail-overline">Certificate details</span><h2>${escapeHTML(cert.name)}</h2></div><div class="detail-head-actions"><span class="badge ${info.tone}">${info.label}</span><button class="icon-close" data-close-detail aria-label="Close certificate details">${icon('close')}</button></div></div>
    <div class="detail-content">${content}</div>`;
  $('#certificate-detail .detail-content').insertAdjacentHTML('beforeend', `<section class="block"><h3>Issuance & diagnostics</h3><dl class="kv"><dt>Issuer</dt><dd>${escapeHTML(cert.issuer || 'Not reported')}</dd><dt>Valid from</dt><dd>${escapeHTML(cert.notBefore || 'Not reported')}</dd><dt>Issued at</dt><dd>${escapeHTML(cert.issuedAt || 'Not reported')}</dd><dt>Key type</dt><dd>${escapeHTML(cert.keyType || 'Not reported')}</dd><dt>Next attempt</dt><dd>${escapeHTML(cert.nextAttemptAt || 'Not reported')}</dd><dt>Last error</dt><dd>${escapeHTML(cert.lastError || cert.error || 'None reported')}</dd></dl></section><section class="block"><h3>Session activity</h3><p>Local to this page session; not a server audit log.</p><ul class="operation-log">${operationLog.filter(item => item.name === cert.name).map(item => `<li><span class="sub">${escapeHTML(item.time)}</span>${escapeHTML(item.message)}</li>`).join('') || '<li>No operations in this session.</li>'}</ul></section>`);
}

function renderAll() {
  $('#deployment-column').textContent = 'CLB bindings';
  const deploymentMetric = $('[data-metric="bindings"] .metric-content > span');
  if (deploymentMetric) deploymentMetric.textContent = 'CLB binding issues';
  const certs = state.certificates;
  $('#metric-total').textContent = certs.length;
  $('#metric-attention').textContent = certs.filter((cert) => statusInfo(cert).dot !== 'ok').length;
  $('#metric-expiring').textContent = certs.filter((cert) => cert.daysLeft != null && cert.daysLeft >= 0 && cert.daysLeft <= 30).length;
  $('#metric-bindings').textContent = certs.filter(bindingIssue).length;
  renderUINMenu();
  renderBindingMenu();
  renderCloudMenu();
  renderRows();
  renderDetail();
  const uinOptions = accountOptions().map((account) => `<option value="${escapeHTML(account.uin)}">${escapeHTML(accountLabel(account))}</option>`).join('');
  const uinSelect = $('#certificate-uin');
  if (uinSelect) {
    const chosen = uinSelect.value;
    uinSelect.innerHTML = uinOptions || '<option value="">No accounts yet</option>';
    uinSelect.disabled = !uinOptions;
    // Re-rendering must not undo a selection the operator already made.
    if (chosen && [...uinSelect.options].some((option) => option.value === chosen)) {
      uinSelect.value = chosen;
    }
  }
  syncDeploymentChoice();
}

function setInventory(certificates, accounts, live) {
  state.certificates = certificates;
  state.accounts = accounts;
  state.live = live;
  if (state.detailOpen && !certificates.some((cert) => cert.name === state.selected)) closeDetail();
  renderAll();
  renderConnection();
}

async function loadLive() {
  const version = ++syncVersion;
  state.syncing = true;
  renderConnection();
  try {
    let bindingError = '';
    const [inventory, accounts, , deployment] = await Promise.all([
      request('GET', '/api/inventory'), request('GET', '/api/accounts'),
      // Still fetched although nothing renders the list, now that binding and detaching a listener
      // are Tencent Cloud console operations: a failure here is what tells the page its binding
      // rows may be stale, and that warning is the reason the request stays.
      request('GET', '/api/bindings').catch(error => { bindingError = error.message; return null; }),
      request('GET', '/api/deployment').catch(error => ({unavailable: error.message}))
    ]);
    if (version !== syncVersion) return;
    state.deployment = deployment?.unavailable ? null : deployment;
    state.deploymentError = deployment?.unavailable || "";
    state.lastSynced = new Date();
    state.syncError = bindingError ? `Binding lookup failed: ${bindingError}` : '';
    setInventory(inventory.certificates || [], accounts.accounts || [], true);
    $('#sync-warning').hidden = !bindingError;
    $('#sync-warning').textContent = bindingError ? `${state.syncError}. Previously loaded bindings may be outdated.` : '';
  } catch (error) {
    if (version !== syncVersion) return;
    state.syncError = error.message;
    $('#sync-warning').hidden = false;
    $('#sync-warning').textContent = `Sync failed: ${error.message}. Displayed data may be outdated; use Refresh to retry.`;
    throw error;
  } finally {
    if (version === syncVersion) { state.syncing = false; renderConnection(); }
  }
}

function closeDrawer() {
  $('#connect-drawer').classList.remove('open');
  $('#drawer-scrim').classList.remove('open');
}

function openDrawer() {
  $('#connect-drawer').classList.add('open');
  $('#drawer-scrim').classList.add('open');
  $('#uin-control').classList.remove('open');
}

function selectCertificate(name) {
  detailReturnFocus = document.activeElement;
  state.selected = name;
  state.detailOpen = true;
  renderRows();
  renderDetail();
  $('#certificate-detail').classList.add('open');
  $('#detail-scrim').classList.add('open');
  document.body.classList.add('detail-open');
  $('#certificate-detail [data-close-detail]').focus();
}

function closeDetail() {
  const wasOpen = state.detailOpen;
  state.selected = '';
  state.detailOpen = false;
  $('#certificate-detail').classList.remove('open');
  $('#detail-scrim').classList.remove('open');
  document.body.classList.remove('detail-open');
  renderRows();
  if (wasOpen) {
    if (detailReturnFocus?.isConnected) detailReturnFocus.focus();
    else $('#certificate-search').focus();
  }
}

// Deleting the certificate's wecert record: a local action with a cloud consequence, spelled out in
// the dialog. It does not detach listeners and does not revoke the certificate.
//
// Binding and detaching a listener used to be offered here as well. Both are Tencent Cloud console
// operations, and this page reports their result (see bindingState) instead of performing them.
function openCertificateDeletion(name) {
  const cert = state.certificates.find(item => item.name === name);
  if (!cert) return;
  if (!state.canAdmin) { toast('Connect with an admin token to manage certificates.'); return; }
  let modal = document.getElementById('certificate-action');
  if (!modal) { modal = document.createElement('div'); modal.id = 'certificate-action'; modal.className = 'modal'; document.body.append(modal); }

  modal.innerHTML = `<form class="modal-card">
    <header class="modal-head"><h2>Delete certificate</h2></header>
    <p>${escapeHTML(name)} · UIN ${escapeHTML(cert.uin || 'Unknown')}</p>
    <p class="security-note">This removes WeCert management and local certificate state. It does not detach cloud listeners or revoke the certificate. ${cert.bindings?.count || 0} bindings are reported; verify their impact before continuing.</p>
    <label class="field">Type the certificate name to confirm<input name="confirmation" required autocomplete="off"></label>
    <p class="form-error" role="alert"></p>
    <div class="modal-actions"><button type="button" class="small-btn">Cancel</button><button class="primary">Delete</button></div></form>`;
  modal.classList.add('open');
  const form = modal.querySelector('form');
  const cancel = form.querySelector('button[type="button"]');
  cancel.onclick = () => { modal.classList.remove('open'); $('#certificate-search').focus(); };
  form.querySelector('input, select')?.focus();

  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('.primary');
    if (button.disabled) return;
    const data = Object.fromEntries(new FormData(form));
    const error = form.querySelector('.form-error');
    if (data.confirmation !== name) { error.textContent = 'Certificate name does not match.'; return; }
    button.disabled = true; cancel.disabled = true; error.textContent = '';
    recordOperation(name, 'Deletion requested');
    try {
      await request('DELETE', `/admin/certificates/${encodeURIComponent(name)}`, undefined, true);
      recordOperation(name, 'Deletion completed');
      toast('Certificate management record deleted; cloud resources were not removed.');
      modal.classList.remove('open');
      try { await loadLive(); } catch { /* Persistent sync warning explains stale data. */ }
    } catch (failure) { error.textContent = failure.message; recordOperation(name, `Failed: ${failure.message}`); }
    finally { button.disabled = false; cancel.disabled = false; }
  };
}

/* ── renew: edit one certificate's declared domain set ─────────────────────────────────────────
   Renewal here means editing the declaration, not re-running issuance with the same names. The
   renew agent (GET/POST /renew/... behind the console's own Basic Auth) reads the certificate's
   declared names, validates the candidate document with the daemon's dry run, keeps a backup, writes
   it, and only then reconciles that one certificate. This page never writes the document and needs
   no path to it; the only thing it adds to an ordinary request is the intent header the agent
   requires, because a renewal is not something a cross-site form should be able to trigger. */
let renewState = null;

function renewRequest(method, path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const headers = { Accept: 'application/json', 'X-Wecert-Intent': 'renew' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${state.base}${path}`, {
    method, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async response => {
    let data;
    try { data = await response.json(); } catch { throw new Error(`The renew agent did not answer with JSON (${response.status}). Check its systemd unit and the /renew/ proxy.`); }
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  }).finally(() => clearTimeout(timeout));
}

function renewDirty() {
  const s = renewState;
  if (!s || !s.data) return false;
  const before = (s.data.desiredDomains || []).slice().sort();
  const after = s.draft.slice().sort();
  return before.length !== after.length || before.some((domain, index) => domain !== after[index]);
}

function renewRemovedBound() {
  const s = renewState;
  if (!s || !s.data) return [];
  return (s.data.boundDomains || []).filter(domain => !s.draft.includes(domain));
}

function addRenewDomain(raw) {
  const s = renewState;
  if (!s || !s.data) return;
  const value = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!value) return;
  if (s.draft.length >= ((s.data.profiles || {}).maxNames || 100)) {
    s.warn = `${(s.data.profiles || {}).maxNames} names is the cap for this profile; remove one first.`;
  } else if (!/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    s.warn = `"${value}" is not a domain name. A wildcard has to be the left-most label: *.example.com`;
  } else if (s.draft.includes(value)) {
    s.warn = `${value} is already in the list.`;
  } else {
    s.draft.push(value);
    s.warn = '';
    s.result = null;
  }
  renderRenewPanel();
  const field = $('#renew-add');
  if (field) field.focus();
}

function removeRenewDomain(value) {
  if (!renewState || !renewState.data) return;
  renewState.draft = renewState.draft.filter(domain => domain !== value);
  renewState.warn = '';
  renewState.result = null;
  renderRenewPanel();
}

async function openRenewPanel(name) {
  renewState = { name, data: null, draft: [], busy: true, warn: '', result: null };
  renderRenewPanel();
  try {
    const data = await renewRequest('GET', `/renew/cert/${encodeURIComponent(name)}`);
    if (!renewState || renewState.name !== name) return;
    renewState.data = data;
    renewState.draft = (data.desiredDomains || []).slice();
  } catch (error) {
    if (renewState && renewState.name === name) renewState.warn = error.message;
  }
  if (renewState && renewState.name === name) renewState.busy = false;
  renderRenewPanel();
  const field = $('#renew-add');
  if (field) field.focus();
}

async function applyRenew() {
  const s = renewState;
  if (!s || !s.data || !renewDirty()) return;
  const draft = s.draft.slice();
  s.busy = true;
  s.warn = '';
  renderRenewPanel();
  try {
    // The agent's confirmation phrase is the certificate name, and the panel names the
    // certificate, so clicking "File change" is that confirmation.
    s.result = await renewRequest('POST', `/renew/cert/${encodeURIComponent(s.name)}`, { domains: draft, confirm: s.name });
    s.data.desiredDomains = draft.slice();
    recordOperation(s.name, `Filed renewal (+${(s.result.added || []).length} / −${(s.result.removed || []).length})`);
    toast(`${s.name}: change filed; the daemon is reissuing it now`);
    setTimeout(() => { loadLive().catch(() => { /* the sync warning explains stale data */ }); }, 2500);
  } catch (error) {
    s.warn = error.message;
  }
  s.busy = false;
  renderRenewPanel();
}

function renderRenewPanel() {
  const s = renewState;
  if (!s) return;
  let modal = document.getElementById('renew-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'renew-modal';
    modal.className = 'modal';
    document.body.append(modal);
  }
  const data = s.data || {};
  const issued = data.issued || {};
  const profiles = data.profiles || {};
  const declared = data.desiredDomains || [];
  const added = s.draft.filter(domain => !declared.includes(domain));
  const removed = declared.filter(domain => !s.draft.includes(domain));
  const boundRemoved = renewRemovedBound();
  const dirty = renewDirty();

  const chips = s.draft.map(domain => `<span class="renew-chip${added.includes(domain) ? ' added' : ''}">${escapeHTML(domain)}<button type="button" class="renew-remove" data-renew-remove="${escapeHTML(domain)}" aria-label="Remove ${escapeHTML(domain)}" title="Remove this name">×</button></span>`).join('')
    || '<span class="field-hint">No names left — a certificate needs at least one.</span>';

  const body = s.busy && !s.data
    ? '<p>Reading the declared domains from the renew agent…</p>'
    : !s.data
      ? `<p class="form-error">${escapeHTML(s.warn || 'The renew agent is not reachable.')}</p>
         <p class="security-note">Renewals are filed by <code>wecert-renew-agent.service</code>; this page reaches it through the <code>/renew/</code> proxy on this host. If the unit is down, or the deployment declares its certificates in the config file instead of a desired-state document, the panel cannot edit anything.</p>`
      : `<p>Edit the names this certificate covers, then file the change. The agent validates it with the daemon's own dry run, keeps a backup of the declared-state document, and reconciles this one certificate.</p>
         <section class="renew-section">
           <h3>Declared domains <span class="section-count">${s.draft.length}</span> <span class="field-hint">limit ${escapeHTML(String(profiles.maxNames || 100))} · first name is the primary</span></h3>
           <div class="renew-domains">${chips}</div>
           <div class="renew-add-row">
             <input id="renew-add" placeholder="www.example.com or *.example.com" autocomplete="off" spellcheck="false">
             <button type="button" class="small-btn" id="renew-add-btn">Add</button>
           </div>
         </section>
         ${s.warn ? `<p class="form-error">${escapeHTML(s.warn)}</p>` : ''}
         ${boundRemoved.length ? `<p class="security-note">Still referenced by a listener: <b>${escapeHTML(boundRemoved.join(', '))}</b>. Removing a name from the declaration does not detach it from the load balancer — the listener keeps serving the current certificate for it until you change it in the Tencent Cloud console.</p>` : ''}
         <section class="renew-section">
           <h3>Current certificate</h3>
           <dl class="kv">
             <dt>Issued for</dt><dd>${(data.issuedDomains || []).map(d => `<span class="mono">${escapeHTML(d)}</span>`).join(' · ') || '—'}</dd>
             <dt>Certificate ID</dt><dd>${issued.certId ? copyButton(issued.certId) : '—'}${issued.alias ? ` <span class="field-hint">${escapeHTML(issued.alias)}</span>` : ''}</dd>
             <dt>Serial</dt><dd>${issued.serial ? `<span class="mono">${escapeHTML(String(issued.serial).slice(0, 24))}</span>` : '—'}</dd>
             <dt>Expires</dt><dd>${issued.daysLeft == null ? '—' : `${escapeHTML(String(issued.daysLeft))} days${issued.notAfter ? ` · ${escapeHTML(issued.notAfter.slice(0, 10))}` : ''}`}</dd>
             <dt>Renewal state</dt><dd>${escapeHTML((data.issue || {}).state || '—')}${(data.issue || {}).hint ? ` <span class="field-hint">${escapeHTML(data.issue.hint)}</span>` : ''}</dd>
           </dl>
           <p class="security-note">Document revision ${escapeHTML(String(data.documentRevision || '').slice(0, 12))}${data.ari ? ` · renewal window from the CA: ${escapeHTML(String(data.ari))}` : ''}</p>
         </section>
         ${s.result ? `<section class="renew-section"><h3>Filed</h3><dl class="kv">
             <dt>Revision</dt><dd>${escapeHTML(String(s.result.revisionBefore || '').slice(0, 12))} → ${escapeHTML(String(s.result.revisionAfter || '').slice(0, 12))}</dd>
             <dt>Added</dt><dd>${escapeHTML((s.result.added || []).join(', ') || '—')}</dd>
             <dt>Removed</dt><dd>${escapeHTML((s.result.removed || []).join(', ') || '—')}</dd>
             <dt>Reconcile</dt><dd>HTTP ${escapeHTML(String((s.result.trigger || {}).httpStatus || '?'))} — the daemon converges this one certificate now; the row refreshes by itself.</dd>
           </dl>${(s.result.boundRemoved || []).length ? `<p class="security-note">Still referenced by a listener: <b>${escapeHTML((s.result.boundRemoved || []).join(', '))}</b>.</p>` : ''}</section>` : ''}
         <div class="modal-actions">
           <button type="button" class="small-btn" data-close-renew>Cancel</button>
           <button type="button" class="primary" id="renew-apply" ${dirty && data.canRenew !== false ? '' : 'disabled'}>${dirty ? `File change (${added.length ? `+${added.length}` : ''}${added.length && removed.length ? ' ' : ''}${removed.length ? `−${removed.length}` : ''})` : 'No change yet'}</button>
         </div>`;

  modal.innerHTML = `<form class="modal-card" onsubmit="return false">
    <header class="modal-head"><h2>Renew ${escapeHTML(s.name)}</h2><button type="button" class="icon-close" data-close-renew aria-label="Close">${icon('close')}</button></header>
    <div class="renew-body">${body}</div>
  </form>`;
  modal.classList.add('open');
  modal.querySelectorAll('[data-close-renew]').forEach(button => {
    button.onclick = () => { modal.classList.remove('open'); renewState = null; $('#certificate-search').focus(); };
  });
  modal.querySelectorAll('[data-renew-remove]').forEach(button => {
    button.onclick = () => removeRenewDomain(button.dataset.renewRemove);
  });
  const input = $('#renew-add');
  if (input) {
    input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addRenewDomain(input.value); input.value = ''; } };
  }
  const addButton = $('#renew-add-btn');
  if (addButton) addButton.onclick = () => { const field = $('#renew-add'); addRenewDomain(field ? field.value : ''); if (field) field.value = ''; };
  const apply = $('#renew-apply');
  if (apply) apply.onclick = applyRenew;
}

function closeDropdowns(except) {
  document.querySelectorAll('.uin-control.open').forEach((control) => {
    if (!except || control !== except) control.classList.remove('open');
  });
}

['#uin-trigger', '#binding-trigger', '#cloud-trigger'].forEach((selector) => {
  $(selector).onclick = () => {
    const control = $(selector).closest('.uin-control');
    const open = control.classList.contains('open');
    closeDropdowns(control);
    control.classList.toggle('open', !open);
  };
});
function updateFilteredView() {
  document.querySelectorAll('[data-metric]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.metric === state.status)));
  if (state.detailOpen && !filteredCertificates().some((cert) => cert.name === state.selected)) closeDetail();
  else { renderRows(); if (state.detailOpen) renderDetail(); }
}
$('#status-filter').insertAdjacentHTML('beforeend', '<option value="expiring">Expiring within 30 days</option><option value="bindings">CLB binding issues</option>');
document.querySelectorAll('.metric').forEach((metric, index) => {
  const button = document.createElement('button');
  button.className = 'metric';
  button.dataset.metric = ['all', 'attention', 'expiring', 'bindings'][index];
  button.setAttribute('aria-pressed', String(index === 0));
  button.innerHTML = `<span class="metric-icon">${icon(['certificate', 'alert', 'clock', 'link'][index])}</span><span class="metric-content">${metric.innerHTML}</span>`;
  metric.replaceWith(button);
});
for (const [selector, symbol, label] of [
  ['#notifications', 'bell', 'Notifications'],
  ['#connect-backend', 'settings', 'Settings'],
  ['#new-certificate', 'plus', 'New certificate'],
  ['#refresh-inventory', 'refresh', 'Refresh']
]) $(selector).innerHTML = `${icon(symbol)}<span>${label}</span>`;
document.querySelectorAll('.icon-close').forEach(button => button.innerHTML = icon('close'));
const search = $('#certificate-search');
const searchBox = document.createElement('div');
searchBox.className = 'search-box';
search.before(searchBox);
searchBox.innerHTML = icon('search');
searchBox.append(search);
search.placeholder = 'Search name or domain';
searchBox.insertAdjacentHTML('beforeend', '<kbd>/</kbd>');
$('.filters').prepend(searchBox);
$('#status-filter').hidden = true;
const sortLabel = document.createElement('label');
sortLabel.className = 'sort-label';
sortLabel.textContent = 'Sort by';
$('#sort-order').before(sortLabel);
sortLabel.append($('#sort-order'));
$('#uin-trigger').innerHTML = `<span id="uin-label">All UINs</span>${icon('down')}`;
$('#binding-trigger').innerHTML = `<span id="binding-label">All bindings</span>${icon('down')}`;
$('#cloud-trigger').innerHTML = `<span id="cloud-label">All clouds</span>${icon('down')}`;
$('#clear-filter').onclick = () => {
  state.uin = 'all'; state.status = 'all'; state.binding = 'all'; state.cloud = 'all'; state.search = '';
  $('#certificate-search').value = ''; $('#status-filter').value = 'all';
  renderUINMenu(); renderBindingMenu(); renderCloudMenu(); updateFilteredView();
};
$('#certificate-search').oninput = (event) => { state.search = event.target.value.trim(); updateFilteredView(); };
$('#status-filter').onchange = (event) => { state.status = event.target.value; updateFilteredView(); };
$('#sort-order').onchange = (event) => { state.sort = event.target.value; updateFilteredView(); };
/* Refresh re-derives the state before re-reading it. The rows an operator looks at right after
   touching the Tencent Cloud console are the ones whose answer changed by hand -- a first bind,
   mostly -- and a plain reload would show the state as of the last pass, up to an hour old. The
   POST is best-effort: a daemon that does not know the route still gets the reload. */
$('#refresh-inventory').onclick = async () => {
  let refreshed = null;
  try { refreshed = await request('POST', '/api/bindings/refresh', {}); } catch { /* older daemon: reload anyway */ }
  try {
    await loadLive();
    const confirmed = (refreshed && refreshed.confirmed) || [];
    if (confirmed.length) toast(`Inventory updated · ${confirmed.join(', ')} confirmed as bound`);
    else if (refreshed && refreshed.incomplete) toast('Inventory updated · the binding check is still running');
    else toast('Inventory updated');
  } catch (error) { toast(error.message); }
};
$('#connect-backend').onclick = () => {
  const url = $('#backend-url');
  // Same-origin is the right default: the daemon is usually behind the same
  // nginx as this page. A literal http://127.0.0.1:9801 is the *browser's*
  // loopback, not the server's, and mixed content blocks it from HTTPS anyway.
  if (url && !url.value.trim()) url.value = location.origin;
  $('#backend-modal').classList.add('open');
};
$('.inventory-heading').insertAdjacentHTML('afterend', '<p id="sync-warning" class="sync-warning" role="alert" hidden></p>');
$('#notification-modal').innerHTML = `<form class="modal-card" id="notification-form"><header class="modal-head"><h2>Alert notifications</h2><span class="spacer"></span><button type="button" class="icon-close" data-close-notifications aria-label="Close">×</button></header><p>Renewal success and failure notifications. Expiry and CLB events are not yet emitted.</p><label class="field">Channel<select id="notify-format"><option value="wecom">WeCom</option><option value="feishu">Feishu</option><option value="dingtalk">DingTalk</option></select></label><label class="field">Robot Webhook URL<input id="notify-url" type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved URL"></label><div class="security-note"><strong>Accepted robot URLs</strong>
<p>WeCom · <code>https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…</code></p>
<p>Feishu · <code>https://open.feishu.cn/open-apis/bot/v2/hook/…</code> (unsigned only)</p>
<p>DingTalk · <code>https://oapi.dingtalk.com/robot/send?access_token=…</code></p>
<p>Must be HTTPS, the exact official host and path, no port, credentials or #fragment. Signed Feishu / DingTalk robots and custom webhooks are rejected.</p></div><p id="notify-result" role="status"></p><div class="modal-actions"><button type="button" class="small-btn" id="notify-test">Send test</button><button class="primary">Save</button></div></form>`;
async function notificationAction(method) {
  const result = $('#notify-result');
  const buttons = document.querySelectorAll('#notification-form button');
  buttons.forEach(button => button.disabled = true);
  result.className = 'form-error';
  result.textContent = method === 'POST' ? 'Sending test…' : 'Saving…';
  try {
    const data = await request(method, '/admin/notifications', { format: $('#notify-format').value, url: $('#notify-url').value.trim() }, true);
    // Success must be unmistakable: the field is cleared on purpose (the secret
    // is never echoed back) and that reads as "nothing happened" otherwise.
    result.className = 'form-ok';
    if (method === 'PUT') {
      result.textContent = 'Saved. The URL is stored on the daemon and is never shown here again. Reload or restart to activate.';
      $('#notify-url').value = '';
      $('#notify-url').placeholder = 'Saved — leave blank to keep it';
    } else {
      result.textContent = data.delivered ? `Test delivered at ${data.time}` : (data.note || 'Test sent.');
    }
  } catch (error) {
    result.className = 'form-error';
    result.textContent = error.message;
  } finally {
    buttons.forEach(button => button.disabled = false);
  }
}
$('#notification-form').onsubmit = event => { event.preventDefault(); notificationAction('PUT'); };
$('#notify-test').onclick = () => notificationAction('POST');
$('#backend-modal h2').textContent = 'System settings';
$('#backend-modal p').textContent = 'Console API access only — this is separate from outgoing alert Webhooks. Tokens are exchanged for HttpOnly session cookies and are never saved in browser storage.';
$('#notifications').onclick = async () => {
  $('#notification-modal').classList.add('open');
  $('#notify-format').focus();
  try {
    const data = await request('GET', '/admin/notifications', undefined, true);
    if (['wecom','feishu','dingtalk'].includes(data.format)) $('#notify-format').value = data.format;
    $('#notify-result').textContent = data.configured ? `Saved channel: ${data.format}. Secret URL hidden.` : 'No channel saved.';
  } catch (error) { $('#notify-result').textContent = error.message; }
};
document.querySelectorAll('[data-close-notifications]').forEach((button) => button.onclick = () => $('#notification-modal').classList.remove('open'));
$('#new-certificate').onclick = () => { syncDeploymentChoice(); updateSummary(); $('#certificate-modal').classList.add('open'); };
$('#certificate-uin-add') && ($('#certificate-uin-add').onclick = (event) => { event.stopPropagation(); openDrawer(); });
$('#close-connect').onclick = closeDrawer;
$('#cancel-uin').onclick = closeDrawer;
$('#drawer-scrim').onclick = closeDrawer;
$('#detail-scrim').onclick = closeDetail;
$('#new-uin-cred').onchange = (event) => $('#credential-fields').classList.toggle('is-hidden', event.target.value !== 'static');
document.querySelectorAll('[data-close-modal]').forEach((button) => button.onclick = () => $('#certificate-modal').classList.remove('open'));
document.querySelectorAll('[data-close-backend]').forEach((button) => button.onclick = () => $('#backend-modal').classList.remove('open'));

$('#backend-form').onsubmit = async (event) => {
  event.preventDefault();
  const error = $('#backend-error');
  const btn = $('#backend-form .primary');
  error.textContent = '';
  btn.disabled = true;
  try {
    const raw = $('#backend-url').value.trim() || location.origin;
    const base = new URL(/^https?:\/\//i.test(raw) ? raw : `${location.protocol}//${raw}`).origin;
    assertSecureTransport(base);
    const session = await fetchJSON(base, 'POST', '/api/session', {
      token: $('#backend-token').value.trim(), adminToken: $('#backend-admin-token').value.trim()
    });
    state.base = base;
    setSession(session);
    $('#backend-token').value = '';
    $('#backend-admin-token').value = '';
    clearLegacyTokens();
    if (!state.canRead) throw new Error('Admin session connected. Add the read token to load inventory.');
    await loadLive();
    $('#backend-modal').classList.remove('open');
    toast('Connected to ' + state.base);
  } catch (failure) { error.textContent = 'Could not connect: ' + explainConnectError(failure); }
  finally { btn.disabled = false; }
};

$('#backend-form .modal-actions').insertAdjacentHTML('afterbegin', '<button type="button" class="small-btn" id="disconnect-backend" hidden>Sign out</button>');
$('#disconnect-backend').onclick = async () => {
  const error = $('#backend-error');
  const button = $('#disconnect-backend');
  button.disabled = true;
  try {
    await fetchJSON(state.base || location.origin, 'DELETE', '/api/session');
    ++syncVersion;
    pendingRequests.forEach(controller => controller.abort());
    clearLegacyTokens();
    state.deployment = null; state.deploymentError = '';
    state.base = ''; state.lastSynced = null; state.syncError = ''; state.syncing = false;
    setSession({read: false, admin: false});
    setInventory([], [], false);
    $('#backend-token').value = ''; $('#backend-admin-token').value = '';
    $('#backend-modal').classList.remove('open');
    toast('Signed out');
  } catch (failure) { error.textContent = `Could not sign out: ${failure.message}`; }
  finally { button.disabled = false; }
};

// "Failed to fetch" is a browser network error, not a daemon reply: the usual
// causes are pointing at 127.0.0.1 from another machine, HTTP from an HTTPS
// page, or a CORS-rejected cross-origin call. Say which.
function explainConnectError(err) {
  const msg = String((err && err.message) || err);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return 'Failed to reach the daemon. Use this page\'s own origin when nginx proxies /api. 127.0.0.1 is the browser\'s machine, and an HTTP URL cannot be called from an HTTPS page.';
  }
  return msg;
}

$('#connect-drawer .drawer-actions, #connect-drawer .modal-actions')?.insertAdjacentHTML('beforebegin', '<p id="account-error" class="form-error" role="alert"></p>');
if (!$('#account-error')) $('#save-uin').before(Object.assign(document.createElement('p'), {id: 'account-error', className: 'form-error'}));
$('#account-error').setAttribute('role', 'alert');
$('#save-uin').onclick = async () => {
  const button = $('#save-uin');
  if (button.disabled) return;
  const error = $('#account-error');
  error.textContent = '';
  button.disabled = true;
  try {
    const uin = $('#new-uin').value.trim();
    const name = $('#new-uin-name').value.trim() || (uin ? `account-${uin}` : 'account');
    const credential = $('#new-uin-cred').value;
    const site = $('#new-uin-site')?.value || '';
    const secretId = $('#new-uin-secret-id').value.trim();
    const secretKey = $('#new-uin-secret-key').value;
    if (credential !== 'static' && !uin) throw new Error('Enter a UIN for role credentials.');
    if (credential === 'static' && (!secretId || !secretKey)) throw new Error('Enter both SecretId and SecretKey.');
    await request('POST', '/admin/accounts', {uin, name, cred: credential, site, secretId, secretKey}, true);
    $('#new-uin-secret-id').value = ''; $('#new-uin-secret-key').value = '';
    closeDrawer();
    try { await loadLive(); toast(`Account ${name} connected`); }
    catch (failure) { toast(`Account saved; refresh failed: ${failure.message}`); }
  } catch (failure) { error.textContent = failure.message; }
  finally { button.disabled = !state.canAdmin; }
};

function syncDnsCredFields() {
  const cred = $('#certificate-dns-cred')?.value || 'reused';
  $('#dns-token-wrap')?.classList.toggle('is-hidden', cred !== 'token');
  $('#dns-file-wrap')?.classList.toggle('is-hidden', cred !== 'file');
}
$('#certificate-dns-cred') && ($('#certificate-dns-cred').onchange = syncDnsCredFields);

/* ── create form: domains, live summary, submit ────────── */

const DEPLOY_LABELS = { clb: 'Tencent CLB', none: 'Issue only' };
const CRED_LABELS = { reused: 'Saved credential', token: 'Scoped token', file: 'Key file' };

function formDomains() {
  return [...document.querySelectorAll('#domain-list .domain-input')]
    .map((input) => input.value.trim())
    .filter(Boolean);
}

// The hidden textarea keeps the payload contract for the submit handler.
function domainSync() {
  const box = $('#certificate-domains');
  if (box) box.value = formDomains().join('\n');
}

function domainAddRow(value) {
  const list = $('#domain-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'domain-row';
  row.innerHTML = '<input class="domain-input" placeholder="api.example.com" autocomplete="off" spellcheck="false">'
    + '<button type="button" class="domain-remove" aria-label="Remove domain">×</button>';
  row.querySelector('.domain-input').value = value || '';
  list.appendChild(row);
}

function createValidate() {
  const name = $('#certificate-name')?.value.trim();
  const domains = formDomains();
  if (!name) return 'Enter a certificate name.';
  if (/[\/\\\x00\n\r]/.test(name) || name === '.' || name === '..') return 'Certificate name must not contain path separators or control characters.';
  if (!domains.length) return 'Enter at least one domain.';
  for (const d of domains) {
    if (!d.includes('.')) return `Invalid domain "${d}": must be a fully qualified domain name (e.g. app.example.com).`;
    if (/^[.-]|[.-]$/.test(d)) return `Invalid domain "${d}": cannot start or end with a dot or hyphen.`;
  }
  if ($('#certificate-deploy')?.value === 'clb' && !$('#certificate-uin')?.value) return 'Connect an account first.';
  if ($('#certificate-deploy')?.value !== 'none' && !state.deployment) return 'Refresh to load deployment settings first.';
  return '';
}

function summaryRow(label, value) {
  return `<div class="summary-row"><span class="summary-label">${label}</span><span class="summary-value">${value}</span></div>`;
}

function updateSummary() {
  const box = $('#summary-rows');
  if (!box) return;
  const domains = formDomains();
  const uin = $('#certificate-uin')?.value || '';
  const provider = $('#certificate-dns-provider')?.value || 'cloudflare';
  const cred = $('#certificate-dns-cred')?.value || 'reused';
  const deploy = $('#certificate-deploy')?.value || 'clb';
  box.innerHTML = summaryRow('Coverage', domains.length
    ? `${domains.length} domain${domains.length === 1 ? '' : 's'}`
    : '<em>No domains yet</em>')
    + (domains.length
      ? `<div class="summary-domains">${domains.map((d) => `<code>${escapeHTML(d)}</code>`).join(' ')}</div>`
      : '')
    + (deploy === 'clb' ? summaryRow('Cloud account', uin ? escapeHTML(uin) : '<em>Not connected</em>') : summaryRow('Deployment host', 'This daemon'))
    + summaryRow('Validation', `${escapeHTML(provider)} · DNS-01 (${escapeHTML(CRED_LABELS[cred] || cred)})`)
    + summaryRow('Delivery', escapeHTML(DEPLOY_LABELS[deploy] || deploy));
  const err = createValidate();
  const state = $('#summary-state');
  if (state) {
    state.classList.toggle('is-ready', !err);
    state.innerHTML = err
      ? `<span aria-hidden="true">·</span><span>${escapeHTML(err)}</span>`
      : '<span aria-hidden="true">✓</span><span>Ready to create</span>';
  }
}

$('#domain-list').addEventListener('input', (event) => {
  if (event.target.classList && event.target.classList.contains('domain-input')) {
    domainSync();
    updateSummary();
  }
});

$('#domain-list').addEventListener('click', (event) => {
  const btn = event.target.closest('.domain-remove');
  if (!btn) return;
  const row = btn.closest('.domain-row');
  const list = $('#domain-list');
  if (list.children.length > 1) row.remove();
  else row.querySelector('.domain-input').value = '';
  domainSync();
  updateSummary();
});

$('#domain-add') && ($('#domain-add').onclick = () => {
  domainAddRow();
  const inputs = document.querySelectorAll('#domain-list .domain-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
  updateSummary();
});

$('#certificate-form').addEventListener('input', updateSummary);
$('#certificate-form').addEventListener('change', updateSummary);

$('#advanced-toggle') && ($('#advanced-toggle').onclick = () => {
  const body = $('#advanced-body');
  if (!body) return;
  body.hidden = !body.hidden;
  $('#advanced-toggle').textContent = body.hidden ? '+ Advanced settings' : '− Advanced settings';
});

$('#certificate-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('#create-submit');
  if (button.disabled) return;
  const box = $('#certificate-form .form-error');
  box.textContent = '';
  const validation = createValidate();
  if (validation) { box.textContent = validation; return; }
  button.disabled = true;
  state.creating = true;
  button.textContent = 'Creating…';
  try {
    const name = $('#certificate-name').value.trim();
    const dnsCred = $('#certificate-dns-cred').value;
    const dns = {provider: $('#certificate-dns-provider').value, cred: dnsCred};
    if (dnsCred === 'token') dns.token = $('#certificate-dns-token').value;
    if (dnsCred === 'file') dns.file = $('#certificate-dns-file').value;
    const created = await request('POST', '/admin/certificates', {
      name, uin: $('#certificate-deploy').value === 'clb' ? $('#certificate-uin').value : '', domains: formDomains(),
      renewBefore: $('#certificate-renew').value,
      profile: $('#certificate-profile').value, keyType: $('#certificate-key').value,
      deploy: $('#certificate-deploy').value, dns
    }, true);
    $('#certificate-dns-token').value = '';
    $('#certificate-modal').classList.remove('open');
    if (created.status !== 'registered') {
      try { await request('POST', '/hook/reconcile', {cert: name}); toast(`${name} created; issuance queued`); }
      catch (failure) { toast(`${name} created; automatic issuance will retry (${failure.message})`); }
    } else { toast(`${name} registered; check daemon configuration before issuance.`); }
    try { await loadLive(); }
    catch (failure) { toast(`Certificate created; refresh failed: ${failure.message}`); }
  } catch (failure) { box.textContent = failure.message; }
  finally { state.creating = false; button.disabled = !state.canAdmin || state.deployment?.editable === false; button.textContent = 'Create certificate'; }
};

// seed the first domain row and refresh the summary when the modal opens
(function hookCreateOpen() {
  const btn = $('#new-certificate');
  if (!btn) return;
  const prev = btn.onclick;
  btn.onclick = (event) => {
    if (typeof prev === 'function') prev(event);
    const list = $('#domain-list');
    if (list && !list.children.length) domainAddRow();
    const errBox = $('#certificate-form .form-error');
    if (errBox) errBox.textContent = '';
    updateSummary();
  };
})();

// Restore only the same-origin HttpOnly cookie session; never reuse stored or URL tokens.
(async function autoConnect() {
  clearLegacyTokens();
  setSession({read: false, admin: false});
  try {
    assertSecureTransport(location.origin);
    state.base = location.origin;
    setSession(await fetchJSON(state.base, 'GET', '/api/session'));
    if (state.canRead) { await loadLive(); return; }
  } catch (error) {
    $('#sync-warning').textContent = `Connection failed: ${error.message}`;
  }
  setInventory([], [], false);
  $('#sync-warning').hidden = false;
  if (!$('#sync-warning').textContent.trim()) $('#sync-warning').textContent = 'Disconnected. Open System settings to connect to the daemon.';
})();

function certificateByName(name) {
  return state.certificates.find((item) => item.name === name);
}

function rowMenuActions(cert) {
  const actions = [['view', 'View details']];
  // There is no /admin/certificates/{name}/renew: asking the daemon to
  // reconcile the certificate is what issues it, and what renews it.
  if (cert.status === 'not_issued') actions.push(['issue', 'Issue now']);
  if (cert.status === 'expired' || (cert.daysLeft != null && cert.daysLeft <= 30)) actions.push(['issue', 'Request renewal']);
  // Attaching and detaching a CLB listener are actions in the Tencent Cloud console. This page
  // manages what Let's Encrypt issued and reports where it ended up bound; it does not change the
  // listener, so it does not offer to. The row and the detail panel show the binding state without
  // a control that would have to reimplement the cloud console's own rules.
  // Renewal is the exception, and the reason is that it is not a cloud-console operation at all: it
  // edits the declared domain set through the renew agent, which is the sanctioned writer of the
  // declaration.
  if (state.canAdmin) actions.push(['renew', 'Renew (edit domains)']);
  if (state.canAdmin) actions.push(['delete', 'Delete certificate']);
  return actions;
}

let rowMenuFor = null;

function closeRowMenu() {
  const menu = $('#row-menu');
  if (menu && rowMenuFor) {
    try { menu.hidePopover(); } catch {}
  }
  rowMenuFor = null;
}

function openRowMenu(trigger, name) {
  const cert = certificateByName(name);
  if (!cert) return;
  const menu = $('#row-menu');
  menu.innerHTML = rowMenuActions(cert).map(([action, label]) =>
    `<button type="button" class="${action === 'delete' ? 'danger-action' : ''}" data-row-action="${action}" data-row-name="${escapeHTML(name)}">${escapeHTML(label)}</button>`
  ).join('');
  menu.style.position = 'fixed';
  try { menu.showPopover(); } catch {}
  const box = menu.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const below = anchor.bottom + 6;
  const top = below + box.height > window.innerHeight ? Math.max(8, anchor.top - box.height - 6) : below;
  const left = Math.min(Math.max(8, anchor.right - box.width), Math.max(8, window.innerWidth - box.width - 8));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  rowMenuFor = name;
}

async function runRowAction(action, name) {
  closeRowMenu();
  const cert = certificateByName(name);
  if (!cert) return;
  if (action === 'view') { selectCertificate(name); return; }
  if (action === 'issue') {
    if (!state.live) { toast('Connect to the daemon before requesting issuance.'); return; }
    recordOperation(name, 'Issuance requested');
    try {
      await request('POST', '/hook/reconcile', { cert: name });
      recordOperation(name, 'Issuance accepted by the daemon');
      toast(`${name}: a reconcile pass has been queued`);
      try { await loadLive(); } catch {}
    } catch (error) { recordOperation(name, `Failed: ${error.message}`); toast(error.message); }
    return;
  }
  // delete has a confirmation modal of its own, and renew has the domain editor. Binding and
  // detaching a listener do not exist here: they are Tencent Cloud console operations.
  if (action === 'renew') { openRenewPanel(name); return; }
  if (action === 'delete') openCertificateDeletion(name);
}

function copyText(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(
      () => toast(`Copied ${value}`),
      () => toast('Copy was blocked by the browser — select the value instead')
    );
    return;
  }
  toast('Copy is not available in this browser');
}

document.addEventListener('click', (event) => {
  const target = event.target;

  const item = target.closest('[data-row-action]');
  if (item) { runRowAction(item.dataset.rowAction, item.dataset.rowName); return; }

  const trigger = target.closest('[data-menu]');
  if (trigger) {
    event.preventDefault();
    if (rowMenuFor === trigger.dataset.menu) { closeRowMenu(); return; }
    openRowMenu(trigger, trigger.dataset.menu);
    return;
  }

  if (rowMenuFor && !target.closest('#row-menu')) closeRowMenu();

  const uinButton = target.closest('.uin-menu [data-uin]');
  if (uinButton) {
    state.uin = uinButton.dataset.uin;
    closeDropdowns();
    renderUINMenu();
    updateFilteredView();
    return;
  }

  const bindingButton = target.closest('.uin-menu [data-binding]');
  if (bindingButton) {
    state.binding = bindingButton.dataset.binding;
    closeDropdowns();
    renderBindingMenu();
    updateFilteredView();
    return;
  }

  const cloudButton = target.closest('.uin-menu [data-cloud]');
  if (cloudButton) {
    state.cloud = cloudButton.dataset.cloud;
    closeDropdowns();
    renderCloudMenu();
    updateFilteredView();
    return;
  }

  // A click anywhere else closes an open filter dropdown; without it a second
  // one stays open behind the list the operator just picked from.
  if (!target.closest('.uin-control')) closeDropdowns();

  const group = target.closest('[data-group]');
  if (group) {
    const uin = group.dataset.group;
    if (state.collapsed.has(uin)) state.collapsed.delete(uin); else state.collapsed.add(uin);
    renderRows();
    return;
  }

  const view = target.closest('[data-action="view"]');
  if (view) { event.preventDefault(); selectCertificate(view.dataset.name); return; }

  const copy = target.closest('[data-copy]');
  if (copy) { event.preventDefault(); copyText(copy.dataset.copy); return; }
});

// The KPI cards are filters: clicking one narrows the inventory to that set.
// aria-pressed is already maintained by updateFilteredView().
document.querySelectorAll('[data-metric]').forEach((card) => {
  card.addEventListener('click', () => {
    state.status = state.status === card.dataset.metric ? 'all' : card.dataset.metric;
    updateFilteredView();
  });
});

document.addEventListener('keydown', (event) => {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
    event.preventDefault();
    $('#certificate-search').focus();
    return;
  }
  if (event.key !== 'Escape') return;
  closeDropdowns();
  if (rowMenuFor) { closeRowMenu(); return; }
  if (state.detailOpen) { closeDetail(); return; }
  ['#certificate-modal', '#backend-modal', '#notification-modal'].forEach((sel) => $(sel).classList.remove('open'));
  if ($('#connect-drawer').classList.contains('open')) closeDrawer();
});


// End of initialization

// Keep focus inside the most recently opened dialog, including nested account drawers.
const openDialogs = new Map();
function activeDialog() { return [...openDialogs.keys()].at(-1); }
function dialogFocusables(dialog) {
  return [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
    .filter(element => element.getClientRects().length && !element.closest('[hidden]'));
}
function focusDialog(dialog) { (dialogFocusables(dialog)[0] || dialog).focus(); }
function updateDialogs() {
  const candidates = [...document.querySelectorAll('.modal, #connect-drawer, #certificate-detail')];
  for (const dialog of candidates) {
    const isOpen = dialog.classList.contains('open');
    if (isOpen && !openDialogs.has(dialog)) {
      openDialogs.set(dialog, document.activeElement);
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('tabindex', '-1');
      const title = dialog.querySelector('h2');
      if (title) { title.id ||= `${dialog.id}-title`; dialog.setAttribute('aria-labelledby', title.id); }
      requestAnimationFrame(() => { if (activeDialog() === dialog) focusDialog(dialog); });
    } else if (!isOpen && openDialogs.has(dialog)) {
      const previous = openDialogs.get(dialog);
      openDialogs.delete(dialog);
      dialog.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
      const top = activeDialog();
      if (top) { if (!top.contains(document.activeElement)) focusDialog(top); }
      else if (previous?.isConnected && !previous.disabled) previous.focus();
      else $('#certificate-search').focus();
    }
  }
}
new MutationObserver(updateDialogs).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
document.addEventListener('keydown', event => {
  const dialog = activeDialog();
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (dialog.id === 'certificate-detail') closeDetail();
    else if (dialog.id === 'connect-drawer') closeDrawer();
    else dialog.classList.remove('open');
  } else if (event.key === 'Tab') {
    const controls = dialogFocusables(dialog);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); }
    else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
}, true);
document.addEventListener('focusin', event => {
  const dialog = activeDialog();
  if (dialog && !dialog.contains(event.target)) focusDialog(dialog);
});

/* Deployment configuration follows the backend reported by this daemon. */
function syncDeploymentChoice() {
  const select = $('#certificate-deploy');
  const supported = state.deployment?.target === 'tencent' ? 'clb' : '';
  for (const option of select.options) option.disabled = option.value !== 'none' && option.value !== supported;
  if (select.selectedOptions[0]?.disabled) select.value = supported || 'none';
  $('#new-certificate').disabled = !state.canAdmin || state.deployment?.editable === false;
  $('#create-submit').disabled = state.creating || !state.canAdmin || state.deployment?.editable === false;
  const accountField = $('#certificate-uin').closest('.field');
  accountField.hidden = select.value !== 'clb';
  let note = $('#deployment-capability-note');
  if (!note) { note = document.createElement('span'); note.id = 'deployment-capability-note'; note.className = 'field-help'; select.after(note); }
  note.textContent = state.deployment && !supported ? 'This console supports Tencent CLB bindings only. Issuance without deployment is available.' : supported ? `This daemon deploys to ${DEPLOY_LABELS[supported]}.` : 'Deployment settings unavailable. Refresh to retry; local issuance is still available.';
}
$('#certificate-deploy').addEventListener('change', syncDeploymentChoice);
