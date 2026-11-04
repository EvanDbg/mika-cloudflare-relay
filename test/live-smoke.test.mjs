/* SPDX-License-Identifier: Apache-2.0
 * Offline regression checks: no gateway, Android device, or external network is used.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { safeDiagnostic } from './live-smoke.mjs';

const SENTINEL = 'SYNTHETIC_PRIVATE_VALUE_NOT_FOR_DIAGNOSTICS_0123456789';
const PRIVATE_HOST = 'unpublished-smoke-target.example.invalid';
const SCRIPT = fileURLToPath(new URL('./live-smoke.mjs', import.meta.url));

function assertSanitized(text) {
  for (const value of [SENTINEL, 'SYNTHETIC_PRIVATE', PRIVATE_HOST]) {
    assert.equal(text.includes(value), false, 'Diagnostic output must not contain configuration or credential data');
  }
}

test('live diagnostics discard assertion messages, actual/expected values, and response bodies', () => {
  let failure;
  try { assert.equal(`Bearer ${SENTINEL}`, 'Bearer expected-test-token'); }
  catch (error) { failure = error; }
  failure.response = { body: SENTINEL };
  const diagnostic = safeDiagnostic(failure, 'phone_response');
  assert.deepEqual(diagnostic, { phase: 'phone_response', category: 'assertion_failed' });
  assertSanitized(JSON.stringify(diagnostic));
});

test('live diagnostics classify transport failures without copying URLs, headers, or stack traces', () => {
  const failure = Object.assign(new Error(`https://user:${SENTINEL}@${PRIVATE_HOST}`), {
    code: 'ECONNRESET', request: { headers: { Authorization: `Bearer ${SENTINEL}` } },
  });
  const diagnostic = safeDiagnostic(failure, 'public_health');
  assert.deepEqual(diagnostic, { phase: 'public_health', category: 'transport_error' });
  assertSanitized(JSON.stringify(diagnostic));
});

test('live diagnostic phases and categories cannot be supplied by an error payload', () => {
  const failure = Object.assign(new Error(SENTINEL), { code: SENTINEL, category: SENTINEL });
  const diagnostic = safeDiagnostic(failure, SENTINEL);
  assert.deepEqual(diagnostic, { phase: 'unknown_phase', category: 'unexpected_error' });
  assertSanitized(JSON.stringify(diagnostic));
});

test('CLI configuration failures produce only safe JSON and leave no personal metadata in reports', async (t) => {
  const cases = [
    { name: 'missing argument', argument: false, expected: { phase: 'arguments', category: 'configuration_required' } },
    { name: 'missing private file', expected: { phase: 'read_configuration', category: 'configuration_read_failed' } },
    { name: 'invalid JSON containing a secret', contents: `${SENTINEL}: this is not JSON`, expected: { phase: 'parse_configuration', category: 'invalid_configuration' } },
    { name: 'credentials embedded in a URL', contents: JSON.stringify({ origin: `https://user:${SENTINEL}@${PRIVATE_HOST}`, ownerKey: SENTINEL }), expected: { phase: 'parse_configuration', category: 'invalid_gateway_origin' } },
    { name: 'invalid administrator key', contents: JSON.stringify({ origin: `https://${PRIVATE_HOST}`, ownerKey: 'short' }), expected: { phase: 'parse_configuration', category: 'invalid_owner_key' } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'mika-smoke-diagnostics-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const file = join(directory, `${SENTINEL}.json`);
      if (entry.contents !== undefined) await writeFile(file, entry.contents);
      const args = entry.argument === false ? [SCRIPT] : [SCRIPT, file];
      const outcome = await new Promise((resolve) => {
        execFile(process.execPath, args, { cwd: directory, timeout: 5_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
      });
      assert.equal(outcome.code, 1);
      assert.equal(outcome.stderr, '', 'Raw exceptions must not bypass the safe diagnostic path');
      assertSanitized(outcome.stdout + outcome.stderr);
      const report = JSON.parse(outcome.stdout);
      assert.equal(report.passed, false);
      assert.deepEqual(report.error, entry.expected);
      for (const key of ['origin', 'startedAt', 'finishedAt']) assert.equal(Object.hasOwn(report, key), false);
      const stored = await readFile(join(directory, 'test-results', 'live-validation.json'), 'utf8');
      assertSanitized(stored);
      assert.deepEqual(JSON.parse(stored), report);
    });
  }
});
