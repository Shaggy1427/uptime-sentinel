/**
 * Parse an accepted-status spec like "200-299" or "200,301,302" or "200-299,404"
 * into a predicate. Invalid segments are ignored rather than throwing, so a typo
 * in one monitor can never take the scheduler down.
 *
 * Specs are stable per monitor while the checks that parse them run every
 * interval forever, so parsed results are memoised: each distinct spec is
 * split and range-checked once, then every check reuses the predicate. The
 * cache is capped because specs are user input via the API.
 */
const PARSED_SPECS = new Map<string, (code: number) => boolean>();
const PARSED_SPEC_CAP = 256;

export function parseAcceptedStatus(spec: string): (code: number) => boolean {
  const cached = PARSED_SPECS.get(spec);
  if (cached) return cached;

  const ranges: Array<[number, number]> = [];
  for (const part of spec.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const dash = seg.indexOf('-', 1);
    if (dash > 0) {
      const lo = Number.parseInt(seg.slice(0, dash), 10);
      const hi = Number.parseInt(seg.slice(dash + 1), 10);
      if (!Number.isNaN(lo) && !Number.isNaN(hi)) ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
    } else {
      const n = Number.parseInt(seg, 10);
      if (!Number.isNaN(n)) ranges.push([n, n]);
    }
  }
  const predicate =
    ranges.length === 0
      ? (code: number) => code >= 200 && code < 300
      : (code: number) => ranges.some(([lo, hi]) => code >= lo && code <= hi);

  if (PARSED_SPECS.size >= PARSED_SPEC_CAP) PARSED_SPECS.clear();
  PARSED_SPECS.set(spec, predicate);
  return predicate;
}
