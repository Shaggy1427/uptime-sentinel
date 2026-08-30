import { execFile } from 'node:child_process';
import type { CheckResult, Monitor } from '../types.ts';

/**
 * Hostnames/IPs only. execFile does not use a shell, so this is not about
 * injection -- it stops a target like "-f" being read as a ping flag.
 */
export const SAFE_HOST = /^[A-Za-z0-9]([A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

export function pingCheck(monitor: Monitor): Promise<CheckResult> {
  const host = monitor.target.trim();
  if (!SAFE_HOST.test(host)) {
    return Promise.resolve({
      ok: false,
      statusCode: null,
      latencyMs: null,
      error: `Invalid ping target "${monitor.target}"`,
    });
  }

  // Both Linux iputils ping and BSD/macOS ping take -W in seconds.
// Windows ping -w takes milliseconds, but this project targets
// Linux/Unix platforms (Raspberry Pi/Unraid homelab).
// Convert ms → s for -W, with a minimum of 1 second.
  const deadlineArg = String(Math.max(1, Math.ceil(monitor.timeoutMs / 1000)));

  return new Promise((resolve) => {
    const started = performance.now();
    execFile(
      'ping',
      ['-n', '-c', '1', '-W', deadlineArg, host],
      { timeout: monitor.timeoutMs + 1000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const wall = Math.round(performance.now() - started);
        if (!err) {
          const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
          const latencyMs = m ? Math.round(Number(m[1])) : wall;
          return resolve({ ok: true, statusCode: null, latencyMs, error: null });
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return resolve({
            ok: false,
            statusCode: null,
            latencyMs: null,
            error: 'ping binary not found (on Debian/Ubuntu: apt install iputils-ping)',
          });
        }
        const out = `${stdout}${stderr}`.trim();
        let error = 'No reply to ICMP echo request';
        if (/unknown host|Name or service not known|Temporary failure/i.test(out)) error = 'DNS lookup failed';
        else if (/Network is unreachable/i.test(out)) error = 'Network unreachable';
        else if (/Operation not permitted/i.test(out)) {
          error = 'ICMP not permitted (container needs sysctl net.ipv4.ping_group_range)';
        } else if (/100% packet loss/i.test(out)) error = 'No reply (100% packet loss)';
        return resolve({ ok: false, statusCode: null, latencyMs: null, error });
      },
    );
  });
}
