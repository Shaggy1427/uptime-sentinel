import { URL } from 'node:url';

/**
 * SSRF guard: deny-list of IP ranges that a monitor target must not reach by
 * default. The dashboard is intentionally a "request primitive" (see SECURITY.md)
 * but on the documented default of an empty AUTH_PASSWORD that primitive reaches
 * anyone who can talk to the port -- and the obvious abuse is reaching
 * 169.254.169.254 to read cloud metadata, or 192.168.1.1 to hit a router admin
 * page from a public-facing install.
 *
 * Blocked ranges:
 *   - loopback: 127.0.0.0/8, ::1
 *   - RFC1918:  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7
 *   - link-local: 169.254.0.0/16 (incl. cloud metadata), fe80::/10
 *   - any-address / unspecified: 0.0.0.0, ::
 *   - multicast / reserved: 224.0.0.0/4, ff00::/8, 240.0.0.0/4
 *
 * Each pattern matches the network address (start-anchored). Hostname-based
 * targets resolve at fetch time and are checked separately.
 */

const V4_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^22[4-9]\./,
  /^23[0-9]\./,
  /^24[0-9]\./,
  /^25[0-5]\./,
];

const V6_PATTERNS: RegExp[] = [
  /^::1$/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
  /^[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f]{0,4}$/i, // placeholder; narrowed below
];

// Multicast ff00::/8 — only meaningful for IPv6, matches at the first nibble.
// "any-address" IPv6 ::.
V6_PATTERNS.push(/^::$/);
V6_PATTERNS.push(/^[fF][0-9a-fA-F]{2}:/);

/** True if a literal IPv4 or IPv6 string is in a denied range. */
export function isPrivateLiteral(host: string): boolean {
  // Strip an IPv6 zone identifier ("fe80::1%eth0") before testing.
  const h = host.split('%')[0]!;

  if (h.includes(':')) {
    for (const re of V6_PATTERNS) if (re.test(h)) return true;
    return false;
  }
  for (const re of V4_PATTERNS) if (re.test(h)) return true;
  return false;
}

/**
 * True when the URL's host is a literal IP in a blocked range. Hostnames are
 * returned as not-blocked; DNS-based blocking happens at fetch time (see
 * `resolveAndCheck`) so a hostname that resolves to a private IP is caught
 * even when the validator does not see the IP literally.
 */
export function isBlockedHttpTarget(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return isPrivateLiteral(url.hostname);
}

/**
 * True when an IPv4 or IPv6 string looks like a literal address (vs a
 * hostname). Used by the ping/tcp validators, where the host is just a string
 * without a URL wrapper.
 */
export function looksLikeLiteralIp(host: string): boolean {
  return /^[0-9.]+$/.test(host) || host.includes(':');
}