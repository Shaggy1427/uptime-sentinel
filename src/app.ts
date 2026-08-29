import { config } from './config.ts';
import { seedIfEmpty } from './seed.ts';
import { scheduler } from './scheduler.ts';
import { heartbeat } from './heartbeat.ts';
import { buildServer } from './server.ts';

export async function start(): Promise<void> {
  seedIfEmpty();

  const app = await buildServer();
  scheduler.start();
  heartbeat.start();

  const address = await app.listen({ port: config.port, host: config.host });

  console.log(`uptime-sentinel listening on ${address}`);
  console.log(`  database        ${config.dbPath}`);
  console.log(`  ntfy topic      ${config.ntfy.topic || '(NOT SET - alerts will be dropped)'}`);
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
