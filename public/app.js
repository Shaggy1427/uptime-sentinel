const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 10_000;

let timer = null;
let editingId = null;

// ------------------------------------------------------------------ helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function duration(ms) {
  if (ms == null) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function ago(ts) {
  return ts == null ? 'never' : `${duration(Date.now() - ts)} ago`;
}

function pct(ratio) {
  return ratio == null ? '--' : `${(ratio * 100).toFixed(ratio > 0.999 ? 2 : 1)}%`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function banner(message, kind) {
  const node = $('#banner');
  if (!message) return node.classList.add('hidden');
  node.textContent = message;
  node.className = `banner ${kind || ''}`;
  if (kind === 'ok') setTimeout(() => node.classList.add('hidden'), 4000);
}

// ------------------------------------------------------------------- render

function sparkline(history) {
  const wrap = el('div', 'spark');
  const slots = 40;
  const padded = Array(Math.max(0, slots - history.length)).fill(null).concat(history.slice(-slots));
  const latencies = history.filter((h) => h.ok && h.latencyMs != null).map((h) => h.latencyMs);
  const max = Math.max(1, ...latencies);

  for (const point of padded) {
    const bar = el('i');
    if (!point) {
      bar.className = 'empty';
    } else if (!point.ok) {
      bar.className = 'bad';
      bar.style.height = '100%';
      bar.title = 'Failed check';
    } else {
      const height = Math.max(12, Math.round(((point.latencyMs ?? 0) / max) * 100));
      bar.style.height = `${height}%`;
      bar.title = `${point.latencyMs ?? '?'}ms - ${new Date(point.checkedAt).toLocaleTimeString()}`;
    }
    wrap.append(bar);
  }
  return wrap;
}

function monitorCard(m) {
  const card = el('article', `card monitor ${m.status}`);

  const head = el('div', 'm-head');
  head.append(el('span', 'dot'), el('span', 'm-name', m.name), el('span', 'm-type', m.type));
  card.append(head, el('div', 'm-target', m.target));

  if (m.status === 'suppressed') {
    card.append(el('div', 'm-waiting', `Not checked — waiting on ${m.suppressedBy ?? 'a dependency'}`));
  }

  if (m.status === 'down' && m.lastResult?.error) {
    const err = el('div', 'm-error', m.lastResult.error);
    if (m.downSinceMs != null) err.textContent += ` - down ${duration(m.downSinceMs)}`;
    card.append(err);
  }

  if (m.dependentCount > 0) {
    card.append(el('div', 'm-deps', `${m.dependentCount} monitor${m.dependentCount === 1 ? '' : 's'} depend on this`));
  }

  card.append(sparkline(m.history));

  const stats = el('div', 'm-stats');
  const stat = (label, value) => {
    const s = el('span', null, `${label} `);
    s.append(el('b', null, value));
    return s;
  };
  stats.append(
    stat('24h', pct(m.uptime.day.ratio)),
    stat('30d', pct(m.uptime.month.ratio)),
    stat('latency', m.uptime.day.avgLatencyMs != null ? `${m.uptime.day.avgLatencyMs}ms` : '--'),
    stat('checked', ago(m.lastCheckedAt)),
  );
  card.append(stats);

  const actions = el('div', 'm-actions');
  if (!m.paused) {
    // Paused monitors are inert; the server refuses manual checks for them.
    const check = el('button', 'tiny ghost', 'Check now');
    check.onclick = async () => {
      check.disabled = true;
      check.textContent = 'Checking...';
      try {
        await api(`/api/monitors/${m.id}/check`, { method: 'POST' });
        await refresh();
      } catch (err) {
        banner(err.message, 'err');
        check.disabled = false;
        check.textContent = 'Check now';
      }
    };
    actions.append(check);
  }

  const pause = el('button', 'tiny ghost', m.paused ? 'Resume' : 'Pause');
  pause.onclick = async () => {
    try {
      await api(`/api/monitors/${m.id}`, { method: 'PATCH', body: JSON.stringify({ paused: !m.paused }) });
      await refresh();
    } catch (err) {
      banner(err.message, 'err');
    }
  };

  const edit = el('button', 'tiny ghost', 'Edit');
  edit.onclick = () => openEditor(m);

  const remove = el('button', 'tiny ghost danger', 'Delete');
  remove.onclick = async () => {
    if (!confirm(`Delete "${m.name}"? Its history and incidents go too.`)) return;
    try {
      await api(`/api/monitors/${m.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      banner(err.message, 'err');
    }
  };

  actions.append(pause, el('span', 'spacer'), edit, remove);
  card.append(actions);
  return card;
}

let lastMonitors = [];

function renderMonitors(monitors) {
  const grid = $('#monitors');
  grid.replaceChildren();
  if (monitors.length === 0) {
    grid.append(el('p', 'empty-state', 'No monitors yet. Click "Add monitor" to start watching something.'));
    return;
  }
  const rank = { down: 0, pending: 1, up: 2, suppressed: 3, paused: 4 };
  monitors.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  for (const m of monitors) grid.append(monitorCard(m));
}

function renderSummary(monitors, notificationsConfigured) {
  const count = (status) => monitors.filter((m) => m.status === status).length;
  const summary = $('#summary');
  summary.replaceChildren();
  const add = (label, value) => {
    const s = el('span', null, `${label} `);
    s.append(el('b', null, String(value)));
    summary.append(s);
  };
  add('up', count('up'));
  add('down', count('down'));
  const suppressed = count('suppressed');
  if (suppressed > 0) add('suppressed', suppressed);
  add('paused', count('paused'));

  if (!notificationsConfigured) {
    // Lives in the summary bar, not the banner, so the 10s refresh does not
    // clobber whatever transient banner the user just triggered.
    const warn = el('span', 'config-warning', 'ntfy not configured - alerts are being dropped');
    warn.title = 'Set NTFY_TOPIC and restart';
    summary.append(warn);
  }
  document.title = count('down') > 0 ? `(${count('down')} down) Uptime Sentinel` : 'Uptime Sentinel';
}

function renderIncidents(incidents) {
  const host = $('#incidents');
  host.replaceChildren();
  if (incidents.length === 0) {
    host.append(el('p', 'empty-state', 'No incidents recorded. Quiet is good.'));
    return;
  }
  const table = el('table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Monitor', 'Started', 'Duration', 'Alerted', 'Cause', '']) hrow.append(el('th', null, h));
  thead.append(hrow);
  const tbody = el('tbody');

  for (const i of incidents) {
    const row = el('tr');
    const end = i.resolvedAt ?? Date.now();
    row.append(
      el('td', null, i.monitorName),
      el('td', null, new Date(i.startedAt).toLocaleString()),
      el('td', null, duration(end - i.startedAt)),
      el('td', null, i.alertedAt ? 'yes' : 'no'),
      el('td', 'cause', i.cause ?? '--'),
    );
    const statusCell = el('td');
    statusCell.append(el('span', `pill ${i.resolvedAt ? 'closed' : 'open'}`, i.resolvedAt ? 'resolved' : 'ongoing'));
    row.append(statusCell);
    tbody.append(row);
  }
  table.append(thead, tbody);
  host.append(table);
}

// ------------------------------------------------------------------ editor

const NO_VALUE_OPERATORS = new Set(['exists', 'not_exists']);

const HINTS = {
  http: 'Full URL including scheme, e.g. http://192.168.1.10/login',
  tcp: 'host:port, e.g. 192.168.1.10:445',
  ping: 'Hostname or IP, e.g. 192.168.1.10',
  json: 'Full URL of an endpoint returning JSON, e.g. http://192.168.1.10/api/health',
};

function syncEditorType() {
  const type = $('#editor-form').elements.type.value;
  $('#target-hint').textContent = HINTS[type];
  for (const node of document.querySelectorAll('.http-only')) node.classList.toggle('hidden', type !== 'http');
  for (const node of document.querySelectorAll('.json-only')) node.classList.toggle('hidden', type !== 'json');
  syncJsonOperator();
}

/** "exists" and "is absent" take no value, so hide the box rather than ignoring it. */
function syncJsonOperator() {
  const form = $('#editor-form');
  const needsValue = !NO_VALUE_OPERATORS.has(form.elements.jsonOperator.value);
  $('#field-json-expected').classList.toggle('hidden', !needsValue);
}

/** Options for "depends on": every other monitor that would not form a loop. */
function fillParentOptions(monitor) {
  const select = $('#editor-form').elements.parentId;
  const banned = new Set(monitor ? [monitor.id, ...descendantIdsOf(monitor.id)] : []);
  select.replaceChildren(el('option', null, 'Nothing — check independently'));
  select.firstChild.value = '';
  for (const candidate of lastMonitors) {
    if (banned.has(candidate.id)) continue;
    const option = el('option', null, candidate.name);
    option.value = String(candidate.id);
    select.append(option);
  }
  select.value = monitor?.parentId ? String(monitor.parentId) : '';
}

/** Ids beneath `id`, so the editor cannot offer a loop the API would reject. */
function descendantIdsOf(id) {
  const out = [];
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    for (const m of lastMonitors) {
      if (m.parentId !== current || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m.id);
      queue.push(m.id);
    }
  }
  return out;
}

function openEditor(monitor) {
  editingId = monitor?.id ?? null;
  const form = $('#editor-form');
  form.reset();
  $('#editor-title').textContent = monitor ? `Edit ${monitor.name}` : 'Add monitor';
  $('#editor-error').classList.add('hidden');

  if (monitor) {
    for (const key of ['name', 'type', 'target', 'intervalS', 'timeoutMs', 'retries', 'alertAfterS', 'reminderEveryS', 'method', 'acceptedStatus', 'jsonPath', 'jsonOperator', 'jsonExpected']) {
      if (form.elements[key]) form.elements[key].value = monitor[key] ?? '';
    }
    form.elements.keyword.value = monitor.keyword ?? '';
    form.elements.keywordInverted.checked = monitor.keywordInverted;
    form.elements.ignoreTls.checked = monitor.ignoreTls;
  }
  fillParentOptions(monitor);
  syncEditorType();
  $('#editor').showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const form = $('#editor-form');
  const f = form.elements;
  const payload = {
    name: f.name.value.trim(),
    type: f.type.value,
    target: f.target.value.trim(),
    intervalS: Number(f.intervalS.value),
    timeoutMs: Number(f.timeoutMs.value),
    retries: Number(f.retries.value),
    alertAfterS: Number(f.alertAfterS.value),
    reminderEveryS: Number(f.reminderEveryS.value),
    method: f.method.value,
    acceptedStatus: f.acceptedStatus.value.trim() || '200-299',
    keyword: f.keyword.value.trim() || null,
    keywordInverted: f.keywordInverted.checked,
    ignoreTls: f.ignoreTls.checked,
    jsonPath: f.jsonPath.value.trim() || null,
    jsonOperator: f.jsonOperator.value,
    jsonExpected: f.jsonExpected.value.trim() || null,
    parentId: f.parentId.value ? Number(f.parentId.value) : null,
  };

  // Only a json monitor carries these; sending them for other types would
  // trip the validator's coherence check.
  if (payload.type !== 'json') {
    payload.jsonPath = null;
    payload.jsonOperator = null;
    payload.jsonExpected = null;
  }

  try {
    if (editingId) await api(`/api/monitors/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/monitors', { method: 'POST', body: JSON.stringify(payload) });
    $('#editor').close();
    await refresh();
  } catch (err) {
    const box = $('#editor-error');
    box.textContent = err.message;
    box.classList.remove('hidden');
  }
}

// ------------------------------------------------------------------- login

function showLogin() {
  if (timer) clearInterval(timer);
  timer = null;
  $('#login').classList.remove('hidden');
}

async function submitLogin(event) {
  event.preventDefault();
  const error = $('#login-error');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    if (!res.ok) throw new Error('Wrong password');
    $('#login').classList.add('hidden');
    error.classList.add('hidden');
    start();
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

// ------------------------------------------------------------ export/import

// The parsed file that the shown preview belongs to, so Apply can only ever
// send exactly what was previewed.
let importPayload = null;

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick rather than immediately: the URL has to still
  // resolve while the browser is handling the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function doExport(event) {
  event.preventDefault();
  const includeSecrets = $('#export-form').elements.includeSecrets.checked;
  try {
    const file = await api(`/api/config/export${includeSecrets ? '?includeSecrets=true' : ''}`);
    download(`uptime-sentinel-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(file, null, 2));
    $('#export').close();
    const count = file.monitors.length;
    banner(`Exported ${count} monitor${count === 1 ? '' : 's'}${includeSecrets ? ', credentials included' : ''}.`, 'ok');
  } catch (err) {
    banner(err.message, 'err');
  }
}

/**
 * Unlike api(), a rejected import is a 400 whose body is the full report, and
 * that report is the useful part -- so it is returned rather than thrown.
 */
async function importRequest(payload, dryRun) {
  const res = await fetch(`/api/config/import${dryRun ? '?dryRun=true' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !Array.isArray(data.errors)) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function renderImportReport(report) {
  const host = $('#import-report');
  host.replaceChildren();

  const line = (label, names, className) => {
    if (names.length === 0) return;
    host.appendChild(el('p', className || 'report-line', `${label}: ${names.join(', ')}`));
  };

  line('Add', report.created);
  line('Update', report.updated);
  line('Unchanged', report.unchanged);
  line(
    'Skipped',
    report.skipped.map((s) => `${s.name} (${s.reason})`),
    'report-line warn',
  );
  line('Credentials to re-enter afterwards', report.needCredentials, 'report-line warn');
  for (const message of report.errors) host.appendChild(el('p', 'report-line error', message));

  if (host.childElementCount === 0) {
    host.appendChild(el('p', 'report-line', 'Nothing to do: this file matches what is already here.'));
  }
  host.classList.remove('hidden');
}

async function previewImport(file) {
  const error = $('#import-error');
  error.classList.add('hidden');
  $('#import-report').classList.add('hidden');
  $('#import-apply').disabled = true;
  importPayload = null;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    error.textContent = 'That file is not valid JSON.';
    error.classList.remove('hidden');
    return;
  }

  try {
    const report = await importRequest(parsed, true);
    renderImportReport(report);
    if (report.errors.length === 0) {
      importPayload = parsed;
      $('#import-apply').disabled = false;
    }
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

async function applyImport(event) {
  event.preventDefault();
  if (!importPayload) return;

  const button = $('#import-apply');
  button.disabled = true;
  try {
    const report = await importRequest(importPayload, false);
    if (report.errors.length > 0) {
      renderImportReport(report);
      return;
    }
    $('#import').close();
    banner(`Imported: ${report.created.length} added, ${report.updated.length} updated.`, 'ok');
    await refresh();
  } catch (err) {
    const error = $('#import-error');
    error.textContent = err.message;
    error.classList.remove('hidden');
    button.disabled = false;
  }
}

function openImport() {
  $('#import-form').reset();
  $('#import-report').classList.add('hidden');
  $('#import-error').classList.add('hidden');
  $('#import-apply').disabled = true;
  importPayload = null;
  $('#import').showModal();
}

// -------------------------------------------------------------------- boot

async function refresh() {
  const [status, incidents] = await Promise.all([api('/api/status'), api('/api/incidents?limit=25')]);
  lastMonitors = status.monitors;
  renderSummary(status.monitors, status.notificationsConfigured);
  renderMonitors(status.monitors);
  renderIncidents(incidents);
  $('#refreshed').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function start() {
  if (timer) clearInterval(timer);
  refresh().catch((err) => banner(err.message, 'err'));
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
}

$('#btn-add').onclick = () => openEditor(null);
$('#editor-cancel').onclick = () => $('#editor').close();
$('#editor-form').addEventListener('submit', saveEditor);
$('#editor-form').elements.type.addEventListener('change', syncEditorType);
$('#editor-form').elements.jsonOperator.addEventListener('change', syncJsonOperator);
$('#login-form').addEventListener('submit', submitLogin);

$('#btn-export').onclick = () => {
  $('#export-form').reset();
  $('#export').showModal();
};
$('#export-cancel').onclick = () => $('#export').close();
$('#export-form').addEventListener('submit', doExport);

$('#btn-import').onclick = openImport;
$('#import-cancel').onclick = () => $('#import').close();
$('#import-form').addEventListener('submit', applyImport);
$('#import-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (file) previewImport(file).catch((err) => banner(err.message, 'err'));
});

$('#btn-test').onclick = async () => {
  const btn = $('#btn-test');
  btn.disabled = true;
  try {
    const res = await api('/api/test-notification', { method: 'POST', body: JSON.stringify({}) });
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length) banner(`Test failed: ${failed.map((r) => `${r.channel}: ${r.error}`).join('; ')}`, 'err');
    else banner('Test notification sent to ntfy.', 'ok');
  } catch (err) {
    banner(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
};

start();
