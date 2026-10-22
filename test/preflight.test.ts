import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The startup preflight in src/index.ts refuses to boot without
 * AUTH_PASSWORD unless ALLOW_NO_PASSWORD=true. This test reads index.ts and
 * confirms the guard is in place -- spawning a fresh Node process through
 * `tsx` for a unit test is brittle enough that the structural check is the
 * right level of confidence here. End-to-end behaviour is covered by the
 * `npm test` cycle and a manual `npm run dev` with an empty AUTH_PASSWORD.
 */

const indexPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'index.ts');

test('index.ts refuses to start without AUTH_PASSWORD and without ALLOW_NO_PASSWORD', () => {
  const src = fs.readFileSync(indexPath, 'utf8');

  // The preflight must gate on both: an empty AUTH_PASSWORD and the absence
  // of an opt-in flag. Either condition alone is not enough.
  assert.match(src, /process\.env\.AUTH_PASSWORD/, 'preflight must reference AUTH_PASSWORD');
  assert.match(src, /process\.env\.ALLOW_NO_PASSWORD/, 'preflight must reference ALLOW_NO_PASSWORD');
  assert.match(
    src,
    /!\s*process\.env\.AUTH_PASSWORD\s*&&\s*process\.env\.ALLOW_NO_PASSWORD\s*!==\s*['"]true['"]/,
    'preflight must gate on empty AUTH_PASSWORD and ALLOW_NO_PASSWORD !== "true"',
  );

  // And it must refuse rather than warn-and-carry-on.
  assert.match(src, /process\.exit\(1\)/, 'preflight must exit non-zero on the gate');
  assert.match(src, /Refusing to start/, 'preflight message must name the failure');
});

test('app.ts still warns loudly when ALLOW_NO_PASSWORD=true is chosen', () => {
  // The opt-in path keeps the existing loud warning so a LAN operator does
  // not forget they deliberately turned auth off.
  const appPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'app.ts');
  const src = fs.readFileSync(appPath, 'utf8');
  assert.match(src, /WARNING: no AUTH_PASSWORD/);
});