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
 * The SHA-256 of `config.authPassword`, computed once and reused.
 *
 * `secretEquals` rehashes both arguments on every call. The configured
 * password is the same for the lifetime of the process, so hashing it
 * every request just to re-derive a value the server already knows
 * burns CPU on the very path the dashboard polls every 10s. Hashing the
 * request input is unavoidable; hashing the stored password is not.
 *
 * An empty password (auth disabled) returns null, so the caller can
 * short-circuit without a hash comparison at all.
 */
let cachedPasswordHash: Buffer | null = null;
let cachedPasswordFor: string | null = null;

export function passwordHash(): Buffer | null {
  const pw = config.authPassword;
  if (pw === '') return null;
  if (cachedPasswordFor !== pw) {
    cachedPasswordHash = createHash('sha256').update(pw, 'utf8').digest();
    cachedPasswordFor = pw;
  }
  return cachedPasswordHash;
}

/**
 * Constant-time check that `input` matches `config.authPassword`.
 *
 * Hashed input is compared against the cached hash of the configured
 * password, so this is one SHA-256 per request rather than two.
 */
export function passwordMatches(input: string): boolean {
  const expected = passwordHash();
  if (expected === null) return false;
  const actual = createHash('sha256').update(input, 'utf8').digest();
  return timingSafeEqual(actual, expected);
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
