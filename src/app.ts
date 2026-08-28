import { config } from './config.ts';
import { seedIfEmpty } from './seed.ts';
import { scheduler } from './scheduler.ts';
import { buildServer } from './server.ts';

export async function start(): Promise<void> {
  seedIfEmpty();

  const app = await buildServer();
  scheduler.start();

  const address = await app.listen({ port: config.port, host: config.host });

  console.log(`uptime-sentinel listening on ${address}`);
  console.log(`  database        ${config.dbPath}`);
  console.log(`  ntfy topic      ${config.ntfy.topic || '(NOT SET - alerts will be dropped)'}`);
  console.log(`  dashboard auth  ${config.authPassword ? 'enabled' : 'disabled'}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);
    scheduler.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
