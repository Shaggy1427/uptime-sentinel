/**
 * Comparison operators for JSON assertions. Data, not code -- see jsonpath.ts.
 *
 * With `disks[*].health`, a path can match many values. The assertion must hold
 * for *every* match: "no disk is failing" is the useful shape, and it must not
 * pass because one healthy disk was found among several failing ones.
 */

export const OPERATORS = [
  'eq',
  'ne',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'not_exists',
] as const;

export type Operator = (typeof OPERATORS)[number];

export function isOperator(value: string): value is Operator {
  return (OPERATORS as readonly string[]).includes(value);
}

/** How a value reads in an error message, without dumping a whole document. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}...` : json;
  }
  return String(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Loose equality across the string/number/boolean boundary, since JSON is untyped in practice. */
function looseEquals(actual: unknown, expected: string): boolean {
  if (actual === null) return expected === 'null';
  if (typeof actual === 'boolean') return String(actual) === expected.toLowerCase();
  if (typeof actual === 'number') {
    const n = asNumber(expected);
    return n !== null && actual === n;
  }
  if (typeof actual === 'string') return actual === expected;
  return JSON.stringify(actual) === expected;
}

export interface AssertResult {
  ok: boolean;
  error: string | null;
}

export function assertValues(matches: unknown[], operator: Operator, expected: string, path: string): AssertResult {
  if (operator === 'exists') {
    return matches.length > 0
      ? { ok: true, error: null }
      : { ok: false, error: `Path "${path}" matched nothing` };
  }
  if (operator === 'not_exists') {
    return matches.length === 0
      ? { ok: true, error: null }
      : { ok: false, error: `Path "${path}" was expected to be absent but found ${describeValue(matches[0])}` };
  }

  // Every other operator needs something to compare against.
  if (matches.length === 0) return { ok: false, error: `Path "${path}" matched nothing` };

  for (const actual of matches) {
    const failure = compare(actual, operator, expected);
    if (failure) {
      const where = matches.length > 1 ? `${path} (one of ${matches.length} matches)` : path;
      return { ok: false, error: `${where}: ${failure}` };
    }
  }

  return { ok: true, error: null };
}

/** Returns null when the value satisfies the operator, or a reason when it does not. */
function compare(actual: unknown, operator: Operator, expected: string): string | null {
  switch (operator) {
    case 'eq':
      return looseEquals(actual, expected) ? null : `expected ${JSON.stringify(expected)}, got ${describeValue(actual)}`;
    case 'ne':
      return looseEquals(actual, expected) ? `expected anything but ${JSON.stringify(expected)}` : null;

    case 'contains':
    case 'not_contains': {
      const hay = typeof actual === 'string' ? actual : JSON.stringify(actual) ?? '';
      const found = hay.includes(expected);
      if (operator === 'contains') return found ? null : `${describeValue(actual)} does not contain ${JSON.stringify(expected)}`;
      return found ? `${describeValue(actual)} contains ${JSON.stringify(expected)}` : null;
    }

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a === null) return `${describeValue(actual)} is not a number`;
      if (b === null) return `expected value ${JSON.stringify(expected)} is not a number`;
      const pass = operator === 'gt' ? a > b : operator === 'gte' ? a >= b : operator === 'lt' ? a < b : a <= b;
      const symbol = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator];
      return pass ? null : `expected ${a} ${symbol} ${b}`;
    }

    default:
      return `unknown operator`;
  }
}
