/**
 * A deliberately small path reader for JSON check assertions.
 *
 * Not JSONPath, and not an expression language. There is no eval anywhere near
 * this: monitor configuration is attacker-reachable on an instance without a
 * password, so the assertion is data (path + operator + value), never code.
 *
 * Supported:
 *   array.state          nested objects
 *   $.array.state        a leading $. is accepted and ignored
 *   disks[0].health      numeric indices
 *   disks[*].health      every element, yielding one value per match
 */

export class PathError extends Error {}

type Segment = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'all' };

/**
 * Parsed paths, memoised by path string.
 *
 * readPath re-tokenises the same path on every check, forever; validation
 * re-parses it on every write too. The parse is a pure function of the
 * string, so each distinct path is tokenised once. The cache is capped
 * because paths are user input via the API.
 */
const PARSED_PATHS = new Map<string, Segment[]>();
const PARSED_PATH_CAP = 256;

export function parsePath(path: string): Segment[] {
  const cached = PARSED_PATHS.get(path);
  if (cached) return cached;

  const trimmed = path.trim().replace(/^\$\.?/, '');
  if (!trimmed) throw new PathError('Path is empty');

  const segments: Segment[] = [];
  // Matches either a bare key, or a [...] accessor.
  const token = /([^.[\]]+)|\[(\*|\d+)\]/g;
  let consumed = 0;
  let prevWasBracket = false;
  let m: RegExpExecArray | null;

  while ((m = token.exec(trimmed)) !== null) {
    // Reject anything the tokeniser skipped over, so typos fail loudly rather
    // than silently matching a different path. Tokens are separated by exactly
    // one dot, except that a bracket accessor may follow a key directly
    // ("a[0]"). Anything else -- a doubled dot, a stray "]", a missing dot
    // after "]" -- must fail, not be read as the path you did not type.
    if (m.index > consumed) {
      const skipped = trimmed.slice(consumed, m.index);
      if (skipped !== '.') throw new PathError(`Unexpected "${skipped}" in path`);
    } else if (prevWasBracket && m[1] !== undefined) {
      throw new PathError(`Missing "." after "]" in path`);
    }
    consumed = token.lastIndex;
    prevWasBracket = m[1] === undefined;

    if (m[1] !== undefined) segments.push({ kind: 'key', key: m[1] });
    else if (m[2] === '*') segments.push({ kind: 'all' });
    else segments.push({ kind: 'index', index: Number.parseInt(m[2]!, 10) });
  }

  // Trailing junk the tokeniser never matched ("state]", "disks[*]x") must
  // not silently shorten the path to whatever came before it.
  if (consumed < trimmed.length) {
    throw new PathError(`Unexpected "${trimmed.slice(consumed)}" in path`);
  }
  if (segments.length === 0) throw new PathError(`Could not read the path "${path}"`);

  if (PARSED_PATHS.size >= PARSED_PATH_CAP) PARSED_PATHS.clear();
  PARSED_PATHS.set(path, segments);
  return segments;
}

/** Every value the path matches. Empty means the path matched nothing. */
export function readPath(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root];

  for (const segment of parsePath(path)) {
    const next: unknown[] = [];
    for (const value of current) {
      if (value === null || value === undefined) continue;

      if (segment.kind === 'key') {
        // Never walk into the prototype chain.
        if (typeof value !== 'object') continue;
        if (!Object.prototype.hasOwnProperty.call(value, segment.key)) continue;
        next.push((value as Record<string, unknown>)[segment.key]);
      } else if (segment.kind === 'index') {
        if (Array.isArray(value) && segment.index < value.length) next.push(value[segment.index]);
      } else {
        if (Array.isArray(value)) next.push(...value);
      }
    }
    current = next;
    if (current.length === 0) return [];
  }

  return current;
}
