import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison is always over 32 bytes:
 * a raw timingSafeEqual would still reveal the expected length by throwing
 * or short-circuiting when the lengths differ.
 */
export function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * A stable, high-entropy key for signing session cookies.
 *
 * Deriving this from AUTH_PASSWORD would tie forgery resistance to how good
 * that password is, so a random key is generated once and kept beside the
 * database. If it cannot be persisted the process still starts with an
 * ephemeral key -- sessions then simply do not survive a restart.
 */
export function cookieSecret(): string {
  const file = path.join(config.dataDir, '.cookie-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Not created yet; fall through and write one.
  }

  const generated = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (err) {
    console.warn(
      `[auth] could not persist a cookie secret to ${file} (${(err as Error).message}). ` +
        'Using an ephemeral key: dashboard sessions will end when the process restarts.',
    );
  }
  return generated;
}
