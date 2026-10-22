/**
 * Entry point and preflight.
 *
 * The app relies on `node:sqlite`, which only exists unflagged from Node 24.
 * On an older runtime the failure would otherwise surface as an opaque
 * ERR_UNKNOWN_BUILTIN_MODULE from deep in the import graph, so the version is
 * checked here and the rest of the app is loaded dynamically afterwards.
 */

const MIN_NODE_MAJOR = 24;

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
  console.error(
    [
      '',
      `  uptime-sentinel needs Node ${MIN_NODE_MAJOR} or newer, but this is Node ${process.versions.node}.`,
      '',
      '  It uses the built-in node:sqlite module, which is unavailable on older',
      '  runtimes. Debian and Raspberry Pi OS still ship Node 18, so a distro',
      '  package is usually the cause.',
      '',
      '  Install a current Node, for example:',
      '    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -',
      '    sudo apt-get install -y nodejs',
      '',
      '  Or use the container image, which bundles the right runtime:',
      '    docker compose up -d',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// Refuse to start with an empty AUTH_PASSWORD unless the operator has opted
// into the no-auth LAN mode. The default install previously printed a warning
// and carried on -- easy to miss on a public-facing deploy where every
// monitor target is then readable by anyone who can reach the port.
if (!process.env.AUTH_PASSWORD && process.env.ALLOW_NO_PASSWORD !== 'true') {
  console.error(
    [
      '',
      '  Refusing to start: AUTH_PASSWORD is not set.',
      '',
      '  An empty AUTH_PASSWORD leaves the API open to anyone who can reach',
      '  this port. They can read every monitor target and make this server',
      '  issue requests to hosts it can reach (the documented "request',
      '  primitive"). Fine on a trusted LAN; dangerous on a public deploy.',
      '',
      '  Pick one of:',
      '    export AUTH_PASSWORD=$(openssl rand -hex 24)   # recommended',
      '    export ALLOW_NO_PASSWORD=true                  # only on a trusted LAN',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

try {
  const { start } = await import('./app.ts');
  await start();
} catch (err) {
  console.error('Fatal startup error:', err);
  process.exit(1);
}
