/**
 * Parse an accepted-status spec like "200-299" or "200,301,302" or "200-299,404"
 * into a predicate. Invalid segments are ignored rather than throwing, so a typo
 * in one monitor can never take the scheduler down.
 */
export function parseAcceptedStatus(spec: string): (code: number) => boolean {
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
  if (ranges.length === 0) return (code) => code >= 200 && code < 300;
  return (code) => ranges.some(([lo, hi]) => code >= lo && code <= hi);
}
