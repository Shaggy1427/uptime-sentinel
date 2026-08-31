import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-channels-'));
process.env.DATA_DIR = tmp;
// Deliberately set: the upgrade path that moves these into a channel row is
// the riskiest part of this feature, so it is exercised rather than mocked.
process.env.NTFY_TOPIC = 'seeded-topic';
process.env.NTFY_TOKEN = 'seeded-token';
process.env.AUTH_PASSWORD = '';

const store = await import('../src/db.ts');
const { dispatch } = await import('../src/notify/index.ts');
const { validateChannel, ValidationError } = await import('../src/validate.ts');
const { seedChannelFromEnv } = await import('../src/seed.ts');
const { buildServer } = await import('../src/server.ts');
const { exportConfig, importConfig } = await import('../src/config-io.ts');
const { scheduler } = await import('../src/scheduler.ts');
const { CHANNEL_SCHEMA, REDACTED, secretKeys } = await import('../src/notify/schema.ts');
import type { NotificationEvent } from '../src/notify/types.ts';
import type { Monitor, NotificationChannel } from '../src/types.ts';

// ---------------------------------------------------------------- fixtures

/** Requests each fake destination received, so delivery is observable. */
const received: { server: string; title: string; body: string; auth: string | null }[] = [];
let ntfyStatus = 200;

const ntfyServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({
      server: 'ntfy',
      title: String(req.headers.title ?? ''),
      body,
      auth: (req.headers.authorization as string) ?? null,
    });
    res.writeHead(ntfyStatus);
    res.end(ntfyStatus === 200 ? '' : 'nope');
  });
});

const discordServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ server: 'discord', title: '', body, auth: null });
    res.writeHead(204);
    res.end();
  });
});

const ntfyPort = await new Promise<number>((r) =>
  ntfyServer.listen(0, '127.0.0.1', () => r((ntfyServer.address() as { port: number }).port)),
);
const discordPort = await new Promise<number>((r) =>
  discordServer.listen(0, '127.0.0.1', () => r((discordServer.address() as { port: number }).port)),
);

// A target the scheduler can fail against.
let mode = 503;
const origin = http.createServer((_req, res) => {
  res.writeHead(mode);
  res.end();
});
const originPort = await new Promise<number>((r) =>
  origin.listen(0, '127.0.0.1', () => r((origin.address() as { port: number }).port)),
);

const ntfyConfig = (topic: string) => ({ url: `http://127.0.0.1:${ntfyPort}`, topic });
const discordConfig = () => ({ webhookUrl: `http://127.0.0.1:${discordPort}/webhook` });

function makeChannel(over: Partial<NotificationChannel> & { name: string }): NotificationChannel {
  return store.createChannel({
    name: over.name,
    type: over.type ?? 'ntfy',
    config: over.config ?? ntfyConfig(over.name),
    enabled: over.enabled ?? true,
    isDefault: over.isDefault ?? false,
  });
}

const event = (monitor: Monitor): NotificationEvent => ({
  kind: 'down',
  monitor,
  incident: null,
  reason: 'boom',
  downForMs: 1000,
  at: Date.now(),
});

let monitorId = 0;

after(async () => {
  await Promise.all([
    new Promise((r) => ntfyServer.close(r)),
    new Promise((r) => discordServer.close(r)),
    new Promise((r) => origin.close(r)),
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const m of store.listMonitors()) store.deleteMonitor(m.id);
  for (const c of store.listChannels()) store.deleteChannel(c.id);
  received.length = 0;
  ntfyStatus = 200;
  mode = 503;
  monitorId = store.createMonitor({
    name: 'target',
    type: 'http',
    target: `http://127.0.0.1:${originPort}/`,
    intervalS: 5,
    timeoutMs: 2000,
    retries: 1,
    alertAfterS: 0,
    reminderEveryS: 0,
  }).id;
});

// ------------------------------------------------------------ the upgrade

test('the env-to-channel seed runs on the migration that created the table', () => {
  // The database in this file was created by this build, so migration 7 ran
  // during import -- exactly the situation an upgrading install is in.
  for (const c of store.listChannels()) store.deleteChannel(c.id);

  const { appliedMigrations, CHANNELS_MIGRATION } = store;

  // Derived from the migration list, not written down. It was 7 until durable
  // login throttling landed first and pushed it to 8 -- and a stale constant
  // would not fail loudly, it would arm the one-time NTFY_* import on the
  // wrong upgrade, leaving an install silently unable to alert.
  assert.ok(CHANNELS_MIGRATION > 0, 'the channels migration must be locatable');
  assert.equal(
    store.db.prepare('PRAGMA user_version').get().user_version >= CHANNELS_MIGRATION,
    true,
    'a database built by this code has applied it',
  );
  assert.ok(
    appliedMigrations.includes(CHANNELS_MIGRATION),
    'and this process applied it, which is what arms the seed',
  );

  // Guarded on the table being empty as well, so calling it twice is safe.
  makeChannel({ name: 'already here' });
  assert.equal(seedChannelFromEnv(), false, 'it will not add a second channel');

  store.deleteChannel(store.listChannels()[0]!.id);
  assert.equal(seedChannelFromEnv(), true);

  const seeded = store.listChannels();
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0]!.name, 'ntfy');
  assert.equal(seeded[0]!.type, 'ntfy');
  assert.equal(seeded[0]!.config.topic, 'seeded-topic', 'NTFY_TOPIC moved across');
  assert.equal(seeded[0]!.config.token, 'seeded-token', 'so did the credential');
  assert.equal(
    seeded[0]!.isDefault,
    true,
    'default, or every existing monitor would go silent the moment it upgraded',
  );
});

// ---------------------------------------------------------------- routing

test('a monitor with no assignment uses the defaults', () => {
  const loud = makeChannel({ name: 'loud', isDefault: true });
  makeChannel({ name: 'not-default' });

  const routed = store.channelsFor(monitorId);
  assert.deepEqual(routed.map((c) => c.name), ['loud']);
  assert.equal(routed[0]!.id, loud.id);
});

test('an assignment replaces the defaults rather than adding to them', () => {
  makeChannel({ name: 'default-one', isDefault: true });
  const quiet = makeChannel({ name: 'quiet' });

  store.setMonitorChannels(monitorId, [quiet.id]);

  assert.deepEqual(
    store.channelsFor(monitorId).map((c) => c.name),
    ['quiet'],
    'picking a channel means picking it instead of, not as well as, the default',
  );
});

test('two channels of the same type is the whole point', () => {
  // The case Option 1 could not express: loud and quiet are both ntfy.
  const loud = makeChannel({ name: 'loud', config: ntfyConfig('loud-topic') });
  const quiet = makeChannel({ name: 'quiet', config: ntfyConfig('quiet-topic') });

  const other = store.createMonitor({ name: 'routine', type: 'ping', target: '127.0.0.1' });
  store.setMonitorChannels(monitorId, [loud.id]);
  store.setMonitorChannels(other.id, [quiet.id]);

  assert.deepEqual(store.channelsFor(monitorId).map((c) => c.config.topic), ['loud-topic']);
  assert.deepEqual(store.channelsFor(other.id).map((c) => c.config.topic), ['quiet-topic']);
});

test('a disabled channel is dropped, and does not fall back to the defaults', () => {
  makeChannel({ name: 'the-default', isDefault: true });
  const chosen = makeChannel({ name: 'chosen' });
  store.setMonitorChannels(monitorId, [chosen.id]);

  store.updateChannel(chosen.id, {
    name: 'chosen', type: 'ntfy', config: ntfyConfig('chosen'), enabled: false, isDefault: false,
  });

  // Switching a channel off silences what it carried. Rerouting those alerts
  // to a default the operator never chose would be a surprise, not a kindness.
  assert.deepEqual(store.channelsFor(monitorId), []);
});

test('deleting a channel returns its monitors to the defaults', () => {
  const fallback = makeChannel({ name: 'fallback', isDefault: true });
  const doomed = makeChannel({ name: 'doomed' });
  store.setMonitorChannels(monitorId, [doomed.id]);
  assert.deepEqual(store.channelsFor(monitorId).map((c) => c.name), ['doomed']);

  store.deleteChannel(doomed.id);

  assert.deepEqual(store.monitorChannelIds(monitorId), [], 'the assignment went with it');
  assert.deepEqual(store.channelsFor(monitorId).map((c) => c.id), [fallback.id]);
});

test('routedChannelNames agrees with channelsFor for every monitor, in one pass', () => {
  const dflt = makeChannel({ name: 'aaa-default', isDefault: true });
  const picked = makeChannel({ name: 'zzz-picked' });
  const other = store.createMonitor({ name: 'other', type: 'ping', target: '127.0.0.1' });
  store.setMonitorChannels(other.id, [picked.id]);
  void dflt;

  const bulk = store.routedChannelNames();
  for (const monitor of store.listMonitors()) {
    assert.deepEqual(
      bulk.get(monitor.id),
      store.channelsFor(monitor.id).map((c) => c.name).sort((a, b) => a.localeCompare(b)),
      `bulk and per-monitor lookups must agree for "${monitor.name}"`,
    );
  }
});

// --------------------------------------------------------------- dispatch

test('dispatch tells apart "nothing configured" from "routed nowhere"', async () => {
  const monitor = store.getMonitor(monitorId)!;

  const nothing = await dispatch(event(monitor), [], false);
  assert.deepEqual(nothing.results, []);
  assert.equal(nothing.reason, 'none-configured');

  // Channels exist, but this monitor reaches none of them. That is a mistake
  // rather than a choice, and it has to be distinguishable or a typo in an
  // assignment silences a monitor forever with nothing in the log.
  makeChannel({ name: 'somewhere' });
  const unrouted = await dispatch(event(monitor), [], true);
  assert.deepEqual(unrouted.results, []);
  assert.equal(unrouted.reason, 'none-matched');
});

test('dispatch fans out to every routed channel and reports each one', async () => {
  const monitor = store.getMonitor(monitorId)!;
  const a = makeChannel({ name: 'phone', config: ntfyConfig('phone') });
  const b = makeChannel({ name: 'chat', type: 'discord', config: discordConfig() });

  const outcome = await dispatch(event(monitor), [a, b], true);

  assert.equal(outcome.reason, 'sent');
  assert.equal(outcome.results.length, 2);
  assert.ok(outcome.results.every((r) => r.ok), JSON.stringify(outcome.results));
  assert.deepEqual(received.map((r) => r.server).sort(), ['discord', 'ntfy']);

  const ntfy = received.find((r) => r.server === 'ntfy')!;
  assert.match(ntfy.title, /^DOWN: target$/);
  assert.match(ntfy.body, /boom/);

  // Both destinations describe the same outage, from the one shared builder.
  const discord = JSON.parse(received.find((r) => r.server === 'discord')!.body);
  assert.equal(discord.embeds[0].title, 'DOWN: target');
  assert.match(discord.embeds[0].description, /boom/);
});

test('one failing channel does not stop the others, and never throws', async () => {
  const monitor = store.getMonitor(monitorId)!;
  ntfyStatus = 500;

  const outcome = await dispatch(
    event(monitor),
    [makeChannel({ name: 'broken' }), makeChannel({ name: 'chat', type: 'discord', config: discordConfig() })],
    true,
  );

  assert.equal(outcome.results.find((r) => r.channel === 'broken')?.ok, false);
  assert.match(outcome.results.find((r) => r.channel === 'broken')!.error!, /500/);
  assert.equal(outcome.results.find((r) => r.channel === 'chat')?.ok, true);
});

test('a channel whose type this build does not know fails that channel alone', async () => {
  const monitor = store.getMonitor(monitorId)!;
  const good = makeChannel({ name: 'good' });
  // Reachable after a downgrade, or after importing a newer export.
  const alien = { ...good, id: good.id + 1000, name: 'alien', type: 'carrier-pigeon' } as NotificationChannel;

  const outcome = await dispatch(event(monitor), [alien, good], true);
  assert.equal(outcome.results.find((r) => r.channel === 'alien')?.ok, false);
  assert.match(outcome.results.find((r) => r.channel === 'alien')!.error!, /unknown channel type/);
  assert.equal(outcome.results.find((r) => r.channel === 'good')?.ok, true);
});

test('control-character stripping is inherited by every type, not just ntfy', async () => {
  const monitor = store.getMonitor(monitorId)!;
  const nasty = { ...event(monitor), reason: 'failed\n[FAKE]\r\x1B[31m' };

  await dispatch(
    nasty,
    [makeChannel({ name: 'phone' }), makeChannel({ name: 'chat', type: 'discord', config: discordConfig() })],
    true,
  );

  // The hardening arrived upstream as a fix for ntfy alone. Sharing one
  // message builder is what stops a second destination reintroducing it.
  const ntfyBody = received.find((r) => r.server === 'ntfy')!.body;
  const discordBody = JSON.parse(received.find((r) => r.server === 'discord')!.body).embeds[0].description;

  for (const [where, text] of [['ntfy', ntfyBody], ['discord', discordBody]] as const) {
    assert.doesNotMatch(text, /[\r\x1B]/, `${where} must not carry terminal controls`);
    assert.match(text, /Error: failed\[FAKE\]\[31m/, `${where} keeps the printable parts`);
  }
});

test('an ntfy channel sends its own token, not another channel’s', async () => {
  const monitor = store.getMonitor(monitorId)!;
  const withToken = makeChannel({ name: 'secured', config: { ...ntfyConfig('t'), token: 'abc123' } });
  const without = makeChannel({ name: 'open', config: ntfyConfig('t2') });

  await dispatch(event(monitor), [withToken, without], true);

  // Compared as a set: the two sends race, and a default sort would order
  // null against a string by stringifying it.
  const auths = received.map((r) => r.auth);
  assert.equal(auths.length, 2);
  assert.equal(auths.filter((a) => a === 'Bearer abc123').length, 1, 'only the secured channel authenticates');
  assert.equal(auths.filter((a) => a === null).length, 1, 'the open one sends no credential at all');
});

// ------------------------------------------------------- the alert paths

test('the scheduler alerts through the routed channel only', async () => {
  const loud = makeChannel({ name: 'loud', config: ntfyConfig('loud') });
  makeChannel({ name: 'unused-default', isDefault: true, config: ntfyConfig('unused') });
  store.setMonitorChannels(monitorId, [loud.id]);

  await scheduler.runNow(monitorId);

  assert.equal(received.length, 1, 'exactly one destination heard about it');
  assert.match(received[0]!.title, /^DOWN: target$/);
  assert.notEqual(store.openIncidentFor(monitorId), null);
});

test('an alert is only recorded once a routed channel actually accepted it', async () => {
  makeChannel({ name: 'flaky', isDefault: true });
  ntfyStatus = 500;

  await scheduler.runNow(monitorId);

  const incident = store.openIncidentFor(monitorId);
  assert.notEqual(incident, null);
  assert.equal(incident!.alertedAt, null, 'a failed send must not count as delivered');

  ntfyStatus = 200;
  await scheduler.runNow(monitorId);
  assert.notEqual(store.openIncidentFor(monitorId)!.alertedAt, null, 'the retry delivered it');
});

test('a monitor routed nowhere still resolves its incident rather than stranding it', async () => {
  makeChannel({ name: 'exists-but-unrelated' });
  store.setMonitorChannels(monitorId, []);

  await scheduler.runNow(monitorId);
  assert.equal(received.length, 0, 'nothing was sent');

  // The incident opened but never alerted, so recovery closes it quietly.
  // Refusing to resolve would leave it open forever: nothing is ever going to
  // deliver it, so there is no retry that could succeed.
  mode = 200;
  await scheduler.runNow(monitorId);
  assert.equal(store.openIncidentFor(monitorId), null);
});

// ------------------------------------------------------------ validation

test('validateChannel enforces each type’s own required fields', () => {
  assert.throws(() => validateChannel({ name: 'x', type: 'ntfy', config: {} }, { partial: false }), /topic is required/);
  assert.throws(() => validateChannel({ name: 'x', type: 'discord', config: {} }, { partial: false }), /webhookUrl is required/);
  assert.throws(() => validateChannel({ name: 'x', type: 'carrier-pigeon' }, { partial: false }), /type must be one of/);
  assert.throws(() => validateChannel({ type: 'ntfy', config: { topic: 't' } }, { partial: false }), /name is required/);
  assert.throws(() => validateChannel({ name: 'x' }, { partial: false }), /type is required/);
  assert.throws(() => validateChannel('nope', { partial: false }), /must be an object/);

  const ok = validateChannel({ name: ' spaced ', type: 'ntfy', config: { topic: 'a' } }, { partial: false });
  assert.equal(ok.name, 'spaced');
  assert.equal(ok.enabled, true, 'a new channel is on unless it says otherwise');
  assert.equal(ok.isDefault, false);
});

test('validateChannel rejects values that would only fail later, at send time', () => {
  const bad: [unknown, RegExp][] = [
    [{ name: 'x', type: 'discord', config: { webhookUrl: 'not a url' } }, /must be a valid URL/],
    [{ name: 'x', type: 'discord', config: { webhookUrl: 'ftp://host/hook' } }, /must be an http\(s\) URL/],
    [{ name: 'x', type: 'ntfy', config: { topic: 't', url: 'javascript:alert(1)' } }, /must be an http\(s\) URL/],
    [{ name: 'x', type: 'ntfy', config: { topic: 't', downPriority: 9 } }, /downPriority/],
    [{ name: 'x', type: 'ntfy', config: { topic: 't', upPriority: 0 } }, /upPriority/],
    [{ name: 'x', type: 'ntfy', config: 'nope' }, /config must be an object/],
    [{ name: 'x', type: 'ntfy', config: { topic: 't' }, enabled: 'yes' }, /enabled must be a boolean/],
  ];
  for (const [body, pattern] of bad) {
    assert.throws(() => validateChannel(body, { partial: false }), pattern, JSON.stringify(body));
  }
});

test('unknown config keys are dropped rather than stored forever', () => {
  const out = validateChannel(
    { name: 'x', type: 'ntfy', config: { topic: 't', nonsense: 'x', __proto__: 'y' } },
    { partial: false },
  );
  assert.deepEqual(Object.keys(out.config).sort(), ['topic']);
});

test('a patch keeps the rest of the config, and does not inherit across a type change', () => {
  const stored = makeChannel({ name: 'store', config: { ...ntfyConfig('keep'), token: 'secret' } });

  const patched = validateChannel({ enabled: false }, { partial: true, current: stored });
  assert.equal(patched.enabled, false);
  assert.equal(patched.config.topic, 'keep', 'the schedule of settings survived');
  assert.equal(patched.config.token, 'secret');

  // An ntfy topic is not a Discord webhook, so nothing carries over.
  assert.throws(
    () => validateChannel({ type: 'discord' }, { partial: true, current: stored }),
    /webhookUrl is required/,
  );
});

// -------------------------------------------------------------- redaction

test('every secret key the schema declares is withheld by the API', async () => {
  const app = await buildServer();
  after(() => app.close());

  makeChannel({ name: 'ntfy-secret', config: { ...ntfyConfig('t'), token: 'TOPSECRET' } });
  makeChannel({ name: 'discord-secret', type: 'discord', config: discordConfig() });

  const body = (await app.inject({ method: 'GET', url: '/api/channels' })).json();
  const serialised = JSON.stringify(body);

  assert.equal(serialised.includes('TOPSECRET'), false, 'the ntfy token must not leave the API');
  assert.equal(serialised.includes('/webhook'), false, 'nor must the Discord webhook URL');

  for (const channel of body) {
    for (const key of secretKeys(channel.type)) {
      assert.equal(channel.config[key], REDACTED, `${channel.type}.${key} should be redacted`);
    }
  }

  // The declaration is the source of truth, so this catches a new type that
  // forgets to mark its credential.
  assert.ok(secretKeys('ntfy').includes('token'));
  assert.ok(secretKeys('discord').includes('webhookUrl'));
  assert.ok(CHANNEL_SCHEMA.ntfy.some((f) => f.key === 'topic' && !f.secret), 'a topic is not a secret');
});

test('saving a redacted secret back leaves the stored credential alone', async () => {
  const app = await buildServer();
  after(() => app.close());

  const channel = makeChannel({ name: 'keeper', config: { ...ntfyConfig('t'), token: 'ORIGINAL' } });

  // Exactly what the editor does: read, change one visible field, save.
  const shown = (await app.inject({ method: 'GET', url: `/api/channels/${channel.id}` })).json();
  assert.equal(shown.config.token, REDACTED);

  const saved = await app.inject({
    method: 'PATCH',
    url: `/api/channels/${channel.id}`,
    payload: { name: 'renamed', config: shown.config },
  });
  assert.equal(saved.statusCode, 200);

  assert.equal(
    store.getChannel(channel.id)!.config.token,
    'ORIGINAL',
    'pressing save must not overwrite the token with the placeholder',
  );
  assert.equal(store.getChannel(channel.id)!.name, 'renamed');
});

// -------------------------------------------------------------------- API

test('the channels API creates, reads, patches and deletes', async () => {
  const app = await buildServer();
  after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/channels',
    payload: { name: 'Phone', type: 'ntfy', isDefault: true, config: { topic: 'phone' } },
  });
  assert.equal(created.statusCode, 201);
  const channel = created.json();
  assert.equal(channel.isDefault, true);

  assert.equal((await app.inject({ method: 'GET', url: '/api/channels' })).json().length, 1);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/channels/${channel.id}` })).json().name,
    'Phone',
  );

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/channels/${channel.id}`,
    payload: { enabled: false },
  });
  assert.equal(patched.json().enabled, false);
  assert.equal(patched.json().config.topic, 'phone', 'the untouched config survived');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/channels/${channel.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/api/channels' })).json().length, 0);
});

test('the channels API answers bad ids and bodies with 400 or 404, never 500', async () => {
  const app = await buildServer();
  after(() => app.close());

  for (const url of ['/api/channels/abc', '/api/channels/0', '/api/channels/-2']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 400, url);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/channels/999999' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/channels/999999' })).statusCode, 404);

  const bad = await app.inject({ method: 'POST', url: '/api/channels', payload: { name: 'x', type: 'ntfy' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /topic is required/);
});

test('the routing endpoint refuses ids that do not exist', async () => {
  const app = await buildServer();
  after(() => app.close());

  const channel = makeChannel({ name: 'real' });

  const ok = await app.inject({
    method: 'PUT',
    url: `/api/monitors/${monitorId}/channels`,
    payload: { channelIds: [channel.id] },
  });
  assert.deepEqual(ok.json().channelIds, [channel.id]);

  // Ignoring a stale id would route the monitor to fewer channels than the
  // operator just chose, and nothing would say so.
  const stale = await app.inject({
    method: 'PUT',
    url: `/api/monitors/${monitorId}/channels`,
    payload: { channelIds: [channel.id, 999999] },
  });
  assert.equal(stale.statusCode, 400);
  assert.match(stale.json().error, /No channel with id 999999/);
  assert.deepEqual(store.monitorChannelIds(monitorId), [channel.id], 'the good assignment stood');

  for (const payload of [{}, { channelIds: 'all' }, { channelIds: [0] }, { channelIds: ['1'] }]) {
    const res = await app.inject({ method: 'PUT', url: `/api/monitors/${monitorId}/channels`, payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/monitors/999999/channels' })).statusCode,
    404,
  );
});

test('/api/status names each monitor’s channels, and warns when there are none', async () => {
  const app = await buildServer();
  after(() => app.close());

  const empty = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.equal(empty.notificationsConfigured, false);
  assert.deepEqual(empty.monitors[0].channels, []);

  makeChannel({ name: 'aaa', isDefault: true });
  const chosen = makeChannel({ name: 'zzz' });

  const withDefault = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.equal(withDefault.notificationsConfigured, true);
  assert.deepEqual(withDefault.monitors[0].channels, ['aaa']);

  store.setMonitorChannels(monitorId, [chosen.id]);
  const withChoice = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.deepEqual(withChoice.monitors[0].channels, ['zzz']);

  // The single-monitor route describes it the same way.
  const one = (await app.inject({ method: 'GET', url: `/api/monitors/${monitorId}` })).json();
  assert.deepEqual(one.channels, ['zzz']);
});

test('test-notification can target one channel, and says which problem it hit', async () => {
  const app = await buildServer();
  after(() => app.close());

  const nothing = await app.inject({ method: 'POST', url: '/api/test-notification', payload: {} });
  assert.equal(nothing.statusCode, 400);
  assert.match(nothing.json().error, /No notification channel is configured/);

  makeChannel({ name: 'elsewhere' });
  store.setMonitorChannels(monitorId, []);
  const unrouted = await app.inject({
    method: 'POST',
    url: '/api/test-notification',
    payload: { monitorId },
  });
  assert.equal(unrouted.statusCode, 400);
  assert.match(unrouted.json().error, /not routed to any enabled channel/);

  // A specific channel can be tested even while switched off: that is how you
  // check a webhook before turning it on.
  const off = makeChannel({ name: 'being-fixed', enabled: false, config: ntfyConfig('fix') });
  const tested = await app.inject({
    method: 'POST',
    url: '/api/test-notification',
    payload: { channelId: off.id },
  });
  assert.equal(tested.statusCode, 200);
  assert.equal(tested.json().results[0].ok, true);
  assert.match(received.at(-1)!.title, /^Test alert:/);

  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/test-notification', payload: { channelId: 999999 } }))
      .statusCode,
    404,
  );
});

// ------------------------------------------------------- export and import

test('channels and routing survive an export and import, credentials withheld', () => {
  const loud = makeChannel({ name: 'Loud', config: { ...ntfyConfig('loud'), token: 'KEEPSECRET' }, isDefault: true });
  makeChannel({ name: 'Quiet', config: ntfyConfig('quiet') });
  store.setMonitorChannels(monitorId, [loud.id]);

  const file = exportConfig();
  assert.equal(file.channels?.length, 2);
  assert.equal(JSON.stringify(file).includes('KEEPSECRET'), false, 'the ordinary export withholds tokens');
  const exportedLoud = file.channels!.find((c) => c.name === 'Loud')!;
  assert.deepEqual(exportedLoud.configRedacted, ['token'], 'and says which key it withheld');
  assert.equal(exportedLoud.config.topic, 'loud', 'non-secret settings do travel');
  assert.deepEqual(file.monitors[0]!.channels, ['Loud'], 'routing recorded by name');

  // Re-importing the same file must not lose the credential it withheld.
  const again = importConfig(file);
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.channelsUpdated.sort(), ['Loud', 'Quiet']);
  assert.deepEqual(again.channelsNeedCredentials, []);
  assert.equal(
    store.listChannels().find((c) => c.name === 'Loud')!.config.token,
    'KEEPSECRET',
    'a redacted round trip must not wipe a working token',
  );
  assert.deepEqual(store.channelsFor(monitorId).map((c) => c.name), ['Loud']);
});

test('includeSecrets exports the credentials, and importing them elsewhere works', () => {
  makeChannel({ name: 'Loud', config: { ...ntfyConfig('loud'), token: 'CARRIED' } });

  const file = exportConfig({ includeSecrets: true });
  assert.equal(file.channels![0]!.config.token, 'CARRIED');
  assert.equal(file.channels![0]!.configRedacted, undefined);

  for (const c of store.listChannels()) store.deleteChannel(c.id);
  const report = importConfig(file);
  assert.deepEqual(report.channelsCreated, ['Loud']);
  assert.equal(store.listChannels()[0]!.config.token, 'CARRIED');
});

test('importing a redacted channel into a fresh install reports the missing credential', () => {
  makeChannel({ name: 'Loud', config: { ...ntfyConfig('loud'), token: 'GONE' } });
  const file = exportConfig();

  for (const c of store.listChannels()) store.deleteChannel(c.id);
  const report = importConfig(file);

  assert.deepEqual(report.channelsCreated, ['Loud']);
  assert.deepEqual(report.channelsNeedCredentials, ['Loud'], 'told, rather than left to wonder');
  assert.equal(store.listChannels()[0]!.config.token, undefined);
});

test('an import naming a channel that does not exist is refused, not trimmed', () => {
  const report = importConfig({
    version: 1,
    exportedAt: Date.now(),
    monitors: [
      {
        name: 'target', type: 'http', target: 'http://127.0.0.1/', intervalS: 60, timeoutMs: 5000,
        retries: 1, alertAfterS: 0, reminderEveryS: 0, acceptedStatus: '200-299', keyword: null,
        keywordInverted: false, ignoreTls: false, method: 'GET', headers: null, jsonPath: null,
        jsonOperator: null, jsonExpected: null, parent: null, paused: false, channels: ['ghost'],
      },
    ],
  });

  assert.match(report.errors.join(' '), /no channel named "ghost"/);
});

test('a file that says nothing about channels leaves routing untouched', () => {
  const kept = makeChannel({ name: 'Kept' });
  store.setMonitorChannels(monitorId, [kept.id]);

  // A monitors-only file, the original seed format.
  const report = importConfig([
    {
      name: 'target', type: 'http', target: 'http://127.0.0.1/', intervalS: 60, timeoutMs: 5000,
      retries: 1, alertAfterS: 0, reminderEveryS: 0, acceptedStatus: '200-299', keyword: null,
      keywordInverted: false, ignoreTls: false, method: 'GET', headers: null, jsonPath: null,
      jsonOperator: null, jsonExpected: null, parent: null, paused: false,
    },
  ]);

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.channelsCreated, []);
  assert.deepEqual(
    store.monitorChannelIds(monitorId),
    [kept.id],
    'absent routing means "no opinion", not "reset to the defaults"',
  );
});
