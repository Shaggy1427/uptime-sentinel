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

// Cards are updated in place rather than rebuilt, so every write is guarded by
// a comparison: touching a node that has not changed would restart its CSS
// transition and, for some properties, cost a needless layout.

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, className) {
  if (node.className !== className) node.className = className;
}

function setTitle(node, title) {
  if (node.title !== title) node.title = title;
}

function setHeight(node, height) {
  if (node.style.height !== height) node.style.height = height;
}

function setShown(node, shown) {
  node.classList.toggle('hidden', !shown);
}

// ------------------------------------------------------------------- render

const SPARK_SLOTS = 40;

/** A fixed row of bars, reused across refreshes so the height transition runs. */
function sparkline() {
  const wrap = el('div', 'spark');
  const bars = [];
  for (let i = 0; i < SPARK_SLOTS; i++) {
    const bar = el('i');
    bars.push(bar);
    wrap.append(bar);
  }

  function update(history) {
    const padded = Array(Math.max(0, SPARK_SLOTS - history.length))
      .fill(null)
      .concat(history.slice(-SPARK_SLOTS));
    const latencies = history.filter((h) => h.ok && h.latencyMs != null).map((h) => h.latencyMs);
    const max = Math.max(1, ...latencies);

    padded.forEach((point, i) => {
      const bar = bars[i];
      if (!point) {
        setClass(bar, 'empty');
        setHeight(bar, '');
        setTitle(bar, '');
      } else if (point.maintenanceId != null) {
        // Drawn at its real latency when there is one, so a window that the
        // service sailed through does not look like an outage. A failure
        // inside a window still shows full height, just not in the down
        // colour: it happened, but it did not count and did not alert.
        setClass(bar, 'maint');
        setHeight(bar, point.ok ? `${Math.max(12, Math.round(((point.latencyMs ?? 0) / max) * 100))}%` : '100%');
        setTitle(
          bar,
          `${point.ok ? `${point.latencyMs ?? '?'}ms` : 'Failed check'} during maintenance - ` +
            `${new Date(point.checkedAt).toLocaleTimeString()}`,
        );
      } else if (!point.ok) {
        setClass(bar, 'bad');
        setHeight(bar, '100%');
        setTitle(bar, 'Failed check');
      } else {
        setClass(bar, '');
        setHeight(bar, `${Math.max(12, Math.round(((point.latencyMs ?? 0) / max) * 100))}%`);
        setTitle(bar, `${point.latencyMs ?? '?'}ms - ${new Date(point.checkedAt).toLocaleTimeString()}`);
      }
    });
  }

  return { node: wrap, update };
}

/**
 * One monitor card, built once and updated in place.
 *
 * The card outlives every refresh, which is the whole point: rebuilding it
 * would throw away keyboard focus, the text the user is halfway through
 * selecting, and the state of a button whose request has not come back yet.
 */
function monitorCard(monitor) {
  // Handlers read this rather than closing over the monitor they were built
  // with, so a click always acts on the freshest data. Closing over `monitor`
  // would leave Edit opening a stale copy.
  let current = monitor;

  const card = el('article');
  const head = el('div', 'm-head');
  const name = el('span', 'm-name');
  const type = el('span', 'm-type');
  head.append(el('span', 'dot'), name, type);

  const target = el('div', 'm-target');
  const maintenance = el('div', 'm-maintenance');
  const routing = el('div', 'm-unrouted');
  const waiting = el('div', 'm-waiting');
  const error = el('div', 'm-error');
  const deps = el('div', 'm-deps');
  const spark = sparkline();

  // Built once and toggled, rather than added and removed, so the card's
  // children never shuffle underneath the user.
  const stats = el('div', 'm-stats');
  const stat = (label) => {
    const wrap = el('span', null, `${label} `);
    const value = el('b');
    wrap.append(value);
    stats.append(wrap);
    return value;
  };
  const dayStat = stat('24h');
  const monthStat = stat('30d');
  const latencyStat = stat('latency');
  const checkedStat = stat('checked');

  const actions = el('div', 'm-actions');

  // Paused monitors are inert; the server refuses manual checks for them.
  const check = el('button', 'tiny ghost', 'Check now');
  check.onclick = async () => {
    check.disabled = true;
    setText(check, 'Checking...');
    try {
      await api(`/api/monitors/${current.id}/check`, { method: 'POST' });
      await refresh();
    } catch (err) {
      banner(err.message, 'err');
    } finally {
      // The card is no longer replaced on refresh, so the button has to put
      // itself back -- and it must do so after the refresh above has run.
      check.disabled = false;
      setText(check, 'Check now');
    }
  };

  const pause = el('button', 'tiny ghost');
  pause.onclick = async () => {
    try {
      await api(`/api/monitors/${current.id}`, { method: 'PATCH', body: JSON.stringify({ paused: !current.paused }) });
      await refresh();
    } catch (err) {
      banner(err.message, 'err');
    }
  };

  const edit = el('button', 'tiny ghost', 'Edit');
  edit.onclick = () => openEditor(current);

  const remove = el('button', 'tiny ghost danger', 'Delete');
  remove.onclick = async () => {
    if (!confirm(`Delete "${current.name}"? Its history and incidents go too.`)) return;
    try {
      await api(`/api/monitors/${current.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      banner(err.message, 'err');
    }
  };

  actions.append(check, pause, el('span', 'spacer'), edit, remove);
  card.append(head, target, maintenance, routing, waiting, error, deps, spark.node, stats, actions);

  function update(next) {
    current = next;

    setClass(card, `card monitor ${next.status}`);
    setText(name, next.name);
    setText(type, next.type);
    setText(target, next.target);

    const inMaintenance = next.status === 'maintenance';
    setShown(maintenance, inMaintenance);
    if (inMaintenance) {
      setText(maintenance, `Maintenance — ${next.maintenance?.name ?? 'window open'}. Still checking, not alerting.`);
    }

    const suppressed = next.status === 'suppressed';
    setShown(waiting, suppressed);
    if (suppressed) setText(waiting, `Not checked — waiting on ${next.suppressedBy ?? 'a dependency'}`);

    // A failure inside a window is reported by the maintenance line above, not
    // as an outage: it did not alert and it does not count.
    const failing = next.status === 'down' && !!next.lastResult?.error;
    setShown(error, failing);
    if (failing) {
      const since = next.downSinceMs != null ? ` - down ${duration(next.downSinceMs)}` : '';
      setText(error, `${next.lastResult.error}${since}`);
    }

    // Only worth saying when it is a problem: a monitor routed nowhere looks
    // exactly like a healthy one until something breaks.
    const unrouted = !next.paused && (next.channels?.length ?? 0) === 0;
    setShown(routing, unrouted);
    if (unrouted) setText(routing, 'No notification channel — alerts for this monitor are dropped');

    setShown(deps, next.dependentCount > 0);
    if (next.dependentCount > 0) {
      setText(deps, `${next.dependentCount} monitor${next.dependentCount === 1 ? '' : 's'} depend on this`);
    }

    spark.update(next.history);

    setText(dayStat, pct(next.uptime.day.ratio));
    setText(monthStat, pct(next.uptime.month.ratio));
    setText(latencyStat, next.uptime.day.avgLatencyMs != null ? `${next.uptime.day.avgLatencyMs}ms` : '--');
    setText(checkedStat, ago(next.lastCheckedAt));

    setShown(check, !next.paused);
    // A check that is mid-request owns its own label until the request
    // settles; a refresh landing in that window must not stomp it.
    if (!check.disabled) setText(check, 'Check now');
    setText(pause, next.paused ? 'Resume' : 'Pause');
  }

  update(monitor);
  return { node: card, update };
}

let lastMonitors = [];

/** Live cards by monitor id, so a refresh can update rather than rebuild. */
const cards = new Map();

/**
 * Put `desired` into `host` in that order, doing nothing if it is already so.
 *
 * Order only changes when a monitor changes status, so in the steady state this
 * performs no DOM moves at all -- which is what keeps focus and selection
 * intact between refreshes.
 */
function reorder(host, desired) {
  const current = [...host.children];
  if (current.length === desired.length && desired.every((node, i) => current[i] === node)) return;

  // Re-appending detaches each node first, which blurs whatever held focus and
  // collapses any selection inside. The nodes are moved rather than rebuilt, so
  // both references stay valid across the move and can simply be put back.
  const active = document.activeElement;
  const refocus = active && host.contains(active) ? active : null;
  // Range objects are live: detaching a node collapses every range pointing
  // into it, clones included. So the boundary points are copied out as plain
  // values and a fresh range is built afterwards -- the nodes themselves are
  // moved rather than rebuilt, so those references stay good.
  const selection = window.getSelection();
  const picked =
    selection && selection.rangeCount > 0 && host.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? (({ startContainer, startOffset, endContainer, endOffset }) => ({
          startContainer,
          startOffset,
          endContainer,
          endOffset,
        }))(selection.getRangeAt(0))
      : null;

  for (const node of desired) host.append(node);

  if (refocus) refocus.focus();
  if (picked) {
    try {
      const restored = document.createRange();
      restored.setStart(picked.startContainer, picked.startOffset);
      restored.setEnd(picked.endContainer, picked.endOffset);
      selection.removeAllRanges();
      selection.addRange(restored);
    } catch {
      // The selected text was re-rendered out from under us; not worth caring.
    }
  }
}

function renderMonitors(monitors) {
  const grid = $('#monitors');
  const rank = { down: 0, pending: 1, up: 2, maintenance: 3, suppressed: 4, paused: 5 };
  // Sorted on a copy: `monitors` is the same array as the lastMonitors global,
  // and rendering has no business reordering what the editor reads.
  const ordered = [...monitors].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));

  if (ordered.length === 0) {
    cards.clear();
    grid.replaceChildren(el('p', 'empty-state', 'No monitors yet. Click "Add monitor" to start watching something.'));
    return;
  }

  const live = new Set(ordered.map((m) => m.id));
  for (const [id, card] of cards) {
    if (live.has(id)) continue;
    card.node.remove();
    cards.delete(id);
  }
  grid.querySelector('.empty-state')?.remove();

  for (const m of ordered) {
    const existing = cards.get(m.id);
    if (existing) {
      existing.update(m);
    } else {
      const card = monitorCard(m);
      cards.set(m.id, card);
      grid.append(card.node);
    }
  }

  reorder(grid, ordered.map((m) => cards.get(m.id).node));
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
  const inMaintenance = count('maintenance');
  if (inMaintenance > 0) add('maintenance', inMaintenance);
  const suppressed = count('suppressed');
  if (suppressed > 0) add('suppressed', suppressed);
  add('paused', count('paused'));

  if (!notificationsConfigured) {
    // Lives in the summary bar, not the banner, so the 10s refresh does not
    // clobber whatever transient banner the user just triggered.
    const warn = el('span', 'config-warning', 'No notification channel - alerts are being dropped');
    warn.title = 'Add one under Channels';
    summary.append(warn);
  }
  document.title = count('down') > 0 ? `(${count('down')} down) Uptime Sentinel` : 'Uptime Sentinel';
}

/** A collision-safe fingerprint of the values rendered by the table. */
function incidentsKey(incidents) {
  return JSON.stringify(
    incidents.map((i) => [
      i.id,
      i.monitorName,
      i.startedAt,
      i.resolvedAt ?? null,
      Boolean(i.alertedAt),
      i.cause ?? null,
    ]),
  );
}

let lastIncidentsKey = null;

function renderIncidents(incidents) {
  const host = $('#incidents');
  const key = incidentsKey(incidents);

  if (key === lastIncidentsKey) {
    // Nothing about the data changed since the last paint, so rebuilding
    // would only churn the DOM every 10s poll. An ongoing incident's
    // duration column is the one thing that ticks on its own; touch just
    // those cells and leave the rest of the table (and any text the user is
    // selecting) alone.
    for (const row of host.querySelectorAll('tr[data-ongoing]')) {
      const cell = row.querySelector('td:nth-child(3)');
      if (cell) setText(cell, duration(Date.now() - Number(row.dataset.startedAt)));
    }
    return;
  }
  lastIncidentsKey = key;

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
    if (i.resolvedAt == null) {
      row.dataset.ongoing = 'true';
      row.dataset.startedAt = String(i.startedAt);
    }
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
  fillChannelOptions(monitor);
  syncEditorType();
  $('#editor').showModal();
}

/**
 * Fill the "Send alerts to" picker.
 *
 * Routing is its own endpoint rather than a monitor field, so the current
 * selection is fetched separately -- and only for an existing monitor, since a
 * new one has nothing to fetch and starts on the defaults.
 */
async function fillChannelOptions(monitor) {
  const picker = $('#editor-form').elements.channelIds;
  const hint = $('#channels-hint');
  picker.replaceChildren();

  try {
    lastChannels = await api('/api/channels');
  } catch {
    // Leave whatever was last known; the editor still works without it.
  }

  const defaults = lastChannels.filter((c) => c.enabled && c.isDefault).map((c) => c.name);
  hint.textContent =
    defaults.length > 0
      ? `Select none to use the default channels (${defaults.join(', ')}).`
      : 'Select none to use the default channels — none are marked default, so nothing would be sent.';

  for (const channel of lastChannels) {
    const option = el('option', null, channel.enabled ? channel.name : `${channel.name} (off)`);
    option.value = String(channel.id);
    picker.append(option);
  }

  if (!monitor) return;
  try {
    const { channelIds } = await api(`/api/monitors/${monitor.id}/channels`);
    const chosen = new Set(channelIds.map(String));
    for (const option of picker.options) option.selected = chosen.has(option.value);
  } catch {
    // A monitor deleted from under the dialog; nothing useful to show.
  }
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

  const channelIds = [...f.channelIds.selectedOptions].map((o) => Number(o.value));

  try {
    // Routing is a separate resource, so it is written after the monitor
    // exists -- which is also the only way a brand-new monitor can have an id
    // to attach it to.
    const saved = editingId
      ? await api(`/api/monitors/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/api/monitors', { method: 'POST', body: JSON.stringify(payload) });
    await api(`/api/monitors/${saved.id}/channels`, {
      method: 'PUT',
      body: JSON.stringify({ channelIds }),
    });
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
    if (!res.ok) {
      // Surface the server's reason. A 429 from the login rate limit is not a
      // wrong password: telling someone with the correct password that it is
      // wrong sends them chasing the one thing that is actually fine.
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Wrong password');
    }
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
  line('Add channel', report.channelsCreated ?? []);
  line('Update channel', report.channelsUpdated ?? []);
  line('Channel credentials to re-enter afterwards', report.channelsNeedCredentials ?? [], 'report-line warn');
  line('Add maintenance window', report.maintenanceCreated ?? []);
  line('Update maintenance window', report.maintenanceUpdated ?? []);
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

/** When the last poll actually succeeded, and whether the current one did. */
let lastSuccessAt = null;
let reachable = true;

/**
 * Say so when the dashboard cannot reach the server.
 *
 * Silence here is the worst possible failure for a monitoring tool: without
 * this the page keeps showing the last good data, all green, indefinitely --
 * the only tell being a footer clock that quietly stopped advancing.
 */
function setReachable(ok) {
  reachable = ok;
  const node = $('#connection');
  setShown(node, !ok);
  if (!ok) {
    setText(node, lastSuccessAt === null ? 'Cannot reach the server' : `Connection lost — data is ${ago(lastSuccessAt)}`);
  }

  const stamp = $('#refreshed');
  if (lastSuccessAt === null) setText(stamp, ' ');
  else if (ok) setText(stamp, `Updated ${new Date(lastSuccessAt).toLocaleTimeString()}`);
  // While offline the absolute time is the misleading part: it looks current.
  else setText(stamp, `Last updated ${ago(lastSuccessAt)}`);
}

async function refresh() {
  const [status, incidents] = await Promise.all([api('/api/status'), api('/api/incidents?limit=25')]);
  lastMonitors = status.monitors;
  renderSummary(status.monitors, status.notificationsConfigured);
  renderMonitors(status.monitors);
  renderIncidents(incidents);
  lastSuccessAt = Date.now();
  setReachable(true);
}

function start() {
  if (timer) clearInterval(timer);
  const tick = () =>
    refresh().catch((err) => {
      // A 401 is not a reachability problem; api() has already shown the login
      // overlay and stopped the timer.
      if (err.message !== 'Unauthorized') setReachable(false);
    });
  tick();
  timer = setInterval(tick, REFRESH_MS);
}

// ---------------------------------------------------------------- channels

/**
 * The fields each channel type needs, mirroring CHANNEL_SCHEMA on the server.
 *
 * Duplicated deliberately: there is no build step here, so the dashboard
 * cannot import the server module. The server validates regardless, so the
 * worst a drift causes is a 400 with a readable message rather than bad data.
 */
const CHANNEL_FIELDS = {
  ntfy: [
    { key: 'url', label: 'Server', placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: 'Topic', placeholder: 'my-alerts', required: true },
    { key: 'token', label: 'Access token', placeholder: '(only for a protected server)', secret: true },
    { key: 'downPriority', label: 'Priority for DOWN', type: 'number', min: 1, max: 5, value: 5 },
    { key: 'upPriority', label: 'Priority for RECOVERED', type: 'number', min: 1, max: 5, value: 3 },
  ],
  discord: [
    { key: 'webhookUrl', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/...', required: true, secret: true },
    { key: 'username', label: 'Post as', placeholder: 'Uptime Sentinel' },
  ],
};

/** Channels as last fetched, so the monitor editor can list them. */
let lastChannels = [];

function renderChannelFields() {
  const host = $('#channel-fields');
  const type = $('#channels-form').elements.type.value;
  host.replaceChildren();

  for (const spec of CHANNEL_FIELDS[type] ?? []) {
    const label = el('label', 'wide');
    label.append(document.createTextNode(spec.label));
    const input = el('input');
    input.name = `config.${spec.key}`;
    if (spec.type) input.type = spec.type;
    if (spec.placeholder) input.placeholder = spec.placeholder;
    if (spec.min != null) input.min = String(spec.min);
    if (spec.max != null) input.max = String(spec.max);
    if (spec.value != null) input.value = String(spec.value);
    if (spec.required) input.required = true;
    label.append(input);
    if (spec.secret) label.append(el('small', null, 'Stored write-only; it is never shown again.'));
    host.append(label);
  }
}

function renderChannelsList(channels) {
  const host = $('#channels-list');
  host.replaceChildren();

  if (channels.length === 0) {
    host.append(el('p', 'hint warn', 'No channels yet — alerts are being dropped. Add one below.'));
    return;
  }

  for (const c of channels) {
    const row = el('div', 'mw-row');
    const text = el('div', 'mw-text');
    text.append(el('b', null, c.name));
    text.append(el('span', 'mw-when', `${c.type}${c.isDefault ? ' · default' : ''}`));
    if (!c.enabled) text.append(el('span', 'mw-off', 'Switched off'));

    const testBtn = el('button', 'tiny ghost', 'Test');
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      try {
        await api('/api/test-notification', { method: 'POST', body: JSON.stringify({ channelId: c.id }) });
        banner(`Test alert sent to "${c.name}"`, 'ok');
      } catch (err) {
        banner(err.message, 'err');
      } finally {
        testBtn.disabled = false;
      }
    };

    const toggle = el('button', 'tiny ghost', c.enabled ? 'Switch off' : 'Switch on');
    toggle.onclick = async () => {
      try {
        await api(`/api/channels/${c.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !c.enabled }) });
        await openChannels();
        await refresh();
      } catch (err) {
        banner(err.message, 'err');
      }
    };

    const remove = el('button', 'tiny ghost danger', 'Delete');
    remove.onclick = async () => {
      if (!confirm(`Delete "${c.name}"? Monitors that used only this channel fall back to the defaults.`)) return;
      try {
        await api(`/api/channels/${c.id}`, { method: 'DELETE' });
        await openChannels();
        await refresh();
      } catch (err) {
        banner(err.message, 'err');
      }
    };

    const actions = el('div', 'mw-actions');
    actions.append(testBtn, toggle, remove);
    row.append(text, actions);
    host.append(row);
  }
}

async function openChannels() {
  $('#channels-error').classList.add('hidden');
  renderChannelFields();
  try {
    lastChannels = await api('/api/channels');
    renderChannelsList(lastChannels);
  } catch (err) {
    banner(err.message, 'err');
    return;
  }
  if (!$('#channels').open) $('#channels').showModal();
}

async function saveChannel(event) {
  event.preventDefault();
  const form = $('#channels-form');
  const error = $('#channels-error');
  error.classList.add('hidden');

  const type = form.elements.type.value;
  const config = {};
  for (const spec of CHANNEL_FIELDS[type] ?? []) {
    const value = form.elements[`config.${spec.key}`]?.value.trim();
    if (value) config[spec.key] = spec.type === 'number' ? Number(value) : value;
  }

  try {
    await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        name: form.elements.name.value.trim(),
        type,
        isDefault: form.elements.isDefault.checked,
        enabled: true,
        config,
      }),
    });
    form.reset();
    await openChannels();
    await refresh();
    banner('Channel added', 'ok');
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
}

// ------------------------------------------------------------- maintenance

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon, Thu" from the bitmask the API stores. */
function weekdayLabel(mask) {
  const days = WEEKDAY_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
  return days.length === 7 ? 'Every day' : days.join(', ');
}

function windowSummary(w) {
  if (w.strategy === 'once') {
    return `${new Date(w.startsAt).toLocaleString()} until ${new Date(w.endsAt).toLocaleString()}`;
  }
  const hh = String(Math.floor(w.startMin / 60)).padStart(2, '0');
  const mm = String(w.startMin % 60).padStart(2, '0');
  const zone = w.timezone || 'server time';
  return `${weekdayLabel(w.weekdays)} at ${hh}:${mm} ${zone}, for ${duration(w.durationS * 1000)}`;
}

/** Only the strategy's own fieldset is shown, matching the union the API takes. */
function syncMaintenanceStrategy() {
  const form = $('#maintenance-form');
  const weekly = form.elements.strategy.value === 'weekly';
  for (const node of form.querySelectorAll('.weekly-only')) node.classList.toggle('hidden', !weekly);
  for (const node of form.querySelectorAll('.once-only')) node.classList.toggle('hidden', weekly);
}

function renderMaintenanceList(windows) {
  const host = $('#maintenance-list');
  host.replaceChildren();

  if (windows.length === 0) {
    host.append(el('p', 'hint', 'No windows yet. Add one below.'));
    return;
  }

  const names = new Map(lastMonitors.map((m) => [m.id, m.name]));
  for (const w of windows) {
    const row = el('div', 'mw-row');
    const text = el('div', 'mw-text');
    text.append(el('b', null, w.name), el('span', 'mw-when', windowSummary(w)));

    const covers = w.monitorIds.map((id) => names.get(id) ?? `#${id}`);
    text.append(el('span', 'mw-covers', covers.length ? `Covers ${covers.join(', ')}` : 'Covers nothing yet'));
    if (!w.active) text.append(el('span', 'mw-off', 'Switched off'));

    const toggle = el('button', 'tiny ghost', w.active ? 'Switch off' : 'Switch on');
    toggle.onclick = async () => {
      try {
        await api(`/api/maintenance/${w.id}`, { method: 'PATCH', body: JSON.stringify({ active: !w.active }) });
        await openMaintenance();
        await refresh();
      } catch (err) {
        banner(err.message, 'err');
      }
    };

    const remove = el('button', 'tiny ghost danger', 'Delete');
    remove.onclick = async () => {
      if (!confirm(`Delete "${w.name}"? Checks it covered start counting towards uptime again.`)) return;
      try {
        await api(`/api/maintenance/${w.id}`, { method: 'DELETE' });
        await openMaintenance();
        await refresh();
      } catch (err) {
        banner(err.message, 'err');
      }
    };

    const actions = el('div', 'mw-actions');
    actions.append(toggle, remove);
    row.append(text, actions);
    host.append(row);
  }
}

async function openMaintenance() {
  const form = $('#maintenance-form');
  $('#maintenance-error').classList.add('hidden');

  const picker = form.elements.monitorIds;
  const chosen = new Set([...picker.selectedOptions].map((o) => o.value));
  picker.replaceChildren();
  for (const m of [...lastMonitors].sort((a, b) => a.name.localeCompare(b.name))) {
    const option = el('option', null, m.name);
    option.value = String(m.id);
    // Rebuilt on every open and after every write, so a selection the user
    // made but has not submitted has to be put back.
    option.selected = chosen.has(option.value);
    picker.append(option);
  }

  syncMaintenanceStrategy();

  try {
    renderMaintenanceList(await api('/api/maintenance'));
  } catch (err) {
    banner(err.message, 'err');
    return;
  }

  if (!$('#maintenance').open) $('#maintenance').showModal();
}

/** A datetime-local value is wall-clock in the browser's zone; Date parses it as such. */
function localInputToEpoch(value) {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

async function saveMaintenance(event) {
  event.preventDefault();
  const form = $('#maintenance-form');
  const error = $('#maintenance-error');
  error.classList.add('hidden');

  const body = {
    name: form.elements.name.value.trim(),
    strategy: form.elements.strategy.value,
    timezone: form.elements.timezone.value.trim(),
    active: true,
    monitorIds: [...form.elements.monitorIds.selectedOptions].map((o) => Number(o.value)),
  };

  if (body.strategy === 'weekly') {
    const mask = [...form.querySelectorAll('input[name="weekday"]:checked')]
      .reduce((acc, box) => acc | (1 << Number(box.value)), 0);
    if (mask === 0) {
      error.textContent = 'Pick at least one day.';
      error.classList.remove('hidden');
      return;
    }
    const [hours, minutes] = form.elements.startTime.value.split(':').map(Number);
    body.weekdays = mask;
    body.startMin = (hours || 0) * 60 + (minutes || 0);
    body.durationS = Number(form.elements.durationMin.value) * 60;
  } else {
    const startsAt = localInputToEpoch(form.elements.startsAt.value);
    const endsAt = localInputToEpoch(form.elements.endsAt.value);
    if (startsAt === null || endsAt === null) {
      error.textContent = 'Give both a start and an end.';
      error.classList.remove('hidden');
      return;
    }
    body.startsAt = startsAt;
    body.endsAt = endsAt;
  }

  try {
    await api('/api/maintenance', { method: 'POST', body: JSON.stringify(body) });
    form.reset();
    await openMaintenance();
    await refresh();
    banner('Maintenance window added', 'ok');
  } catch (err) {
    error.textContent = err.message;
    error.classList.remove('hidden');
  }
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

$('#btn-channels').onclick = () => openChannels().catch((err) => banner(err.message, 'err'));
$('#channels-cancel').onclick = () => $('#channels').close();
$('#channels-form').addEventListener('submit', saveChannel);
$('#channels-form').elements.type.addEventListener('change', renderChannelFields);

$('#btn-maintenance').onclick = () => openMaintenance().catch((err) => banner(err.message, 'err'));
$('#maintenance-cancel').onclick = () => $('#maintenance').close();
$('#maintenance-form').addEventListener('submit', saveMaintenance);
$('#maintenance-form').elements.strategy.addEventListener('change', syncMaintenanceStrategy);

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
