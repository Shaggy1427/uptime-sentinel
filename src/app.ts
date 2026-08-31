import { config } from './config.ts';
import { seedChannelFromEnv, seedIfEmpty } from './seed.ts';
import { scheduler } from './scheduler.ts';
import { heartbeat } from './heartbeat.ts';
import { buildServer } from './server.ts';
import { listChannels } from './db.ts';

/**
 * What the startup banner says about alerting.
 *
 * It used to print NTFY_TOPIC, which stops being the truth once channels are
 * rows: the operator needs to know whether anything can actually be alerted,
 * and which destinations a monitor with no explicit choice will reach.
 */
function channelSummary(): string {
  const channels = listChannels();
  const enabled = channels.filter((c) => c.enabled);
  if (enabled.length === 0) return '(NONE ENABLED - alerts will be dropped)';
  const defaults = enabled.filter((c) => c.isDefault).map((c) => c.name);
  const names = enabled.map((c) => `${c.name} (${c.type})`).join(', ');
  return defaults.length > 0 ? `${names} [default: ${defaults.join(', ')}]` : `${names} (no default set)`;
}

export async function start(): Promise<void> {
  seedIfEmpty();
  // Before the server comes up, so an upgrading install never serves a request
  // in the window where it has monitors but no channel to alert through.
  seedChannelFromEnv();

  const app = await buildServer();
  scheduler.start();
  heartbeat.start();

  const address = await app.listen({ port: config.port, host: config.host });

  console.log(`uptime-sentinel listening on ${address}`);
  console.log(`  database        ${config.dbPath}`);
  console.log(`  channels        ${channelSummary()}`);
  console.log(`  dashboard auth  ${config.authPassword ? 'enabled' : 'disabled'}`);
  console.log(`  heartbeat       ${config.heartbeat.url ? `every ${config.heartbeat.intervalS}s` : '(not configured - nothing watches this process)'}`);

  if (!config.authPassword) {
    console.warn(
      [
        '',
        '  WARNING: no AUTH_PASSWORD is set, so the API is open to anyone who can',
        '  reach this port. They can read every monitor target, and create monitors',
        '  that make this server issue arbitrary HTTP requests and TCP connections',
        '  to hosts it can reach -- including ones they cannot reach themselves.',
        '',
        '  Fine on a trusted LAN. Set AUTH_PASSWORD before exposing it any wider.',
        '',
      ].join('\n'),
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);
    heartbeat.stop();
    scheduler.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
