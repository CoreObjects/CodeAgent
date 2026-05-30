import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, nextBackoffMs, runWithResilience } from '../src/resilience.js';

// REQ-017: classify rate-limit / auth-refresh failures from either agent; retry
// auth ONCE (no API-key injection — each agent refreshes its own token), apply
// capped exponential backoff for rate limits, and escalate past a failure cap
// rather than spinning. `sleep` and `onEscalate` are injected so tests are fast
// and deterministic.

// --- 18.1 classifier ---

test('classifyFailure detects rate-limit signatures from either agent', () => {
  for (const s of ['429 Too Many Requests', 'rate limit exceeded', 'usage limit reached', 'Overloaded', 'quota exhausted']) {
    assert.equal(classifyFailure({ stderr: s }), 'rate_limit', s);
  }
});

test('classifyFailure detects auth-refresh signatures', () => {
  for (const s of ['401 Unauthorized', 'authentication_error', 'OAuth token expired', 'please run claude login']) {
    assert.equal(classifyFailure({ stderr: s }), 'auth_refresh', s);
  }
});

test('classifyFailure returns none for a clean success and for unknown errors', () => {
  assert.equal(classifyFailure({ stdout: 'all good', code: 0 }), 'none');
  assert.equal(classifyFailure({ stderr: 'ENOENT: missing file' }), 'none');
  assert.equal(classifyFailure(null), 'none');
});

test('classifyFailure also reads a raw string and exit codes', () => {
  assert.equal(classifyFailure('HTTP 429'), 'rate_limit');
  assert.equal(classifyFailure({ exitCode: 401, stderr: '' }), 'auth_refresh');
});

// --- 18.3 backoff schedule ---

test('nextBackoffMs is exponential and capped', () => {
  const opts = { baseMs: 1000, factor: 2, capMs: 8000 };
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((a) => nextBackoffMs(a, opts)),
    [1000, 2000, 4000, 8000, 8000], // capped at 8000
  );
});

// --- 18.2 auth single retry ---

test('auth-refresh failure retries the SAME operation exactly once, then succeeds', async () => {
  let calls = 0;
  const op = async () => (++calls === 1 ? { stderr: '401 Unauthorized' } : { stdout: 'ok', code: 0 });
  let authRetries = 0;
  const r = await runWithResilience(op, {
    onAuthRetry: () => authRetries++, // a logging hook only — NEVER injects a key
    sleep: async () => {},
    onEscalate: async () => 'x',
  });
  assert.equal(calls, 2); // one retry
  assert.equal(authRetries, 1);
  assert.equal(r.stdout, 'ok');
});

test('a second consecutive auth failure escalates instead of looping', async () => {
  const op = async () => ({ stderr: '401 unauthorized' });
  let info = null;
  const r = await runWithResilience(op, { sleep: async () => {}, onEscalate: async (i) => ((info = i), 'wait') });
  assert.equal(r.escalated, true);
  assert.equal(info.kind, 'auth_refresh');
  assert.equal(r.answer, 'wait');
});

// --- 18.3 rate-limit backoff ---

test('rate-limit failures back off (capped exponential) then proceed on success', async () => {
  const results = [{ stderr: '429' }, { stderr: 'rate limit' }, { stdout: 'done', code: 0 }];
  let i = 0;
  const op = async () => results[i++];
  const delays = [];
  const r = await runWithResilience(op, {
    baseMs: 100,
    factor: 2,
    capMs: 1000,
    sleep: async (ms) => delays.push(ms),
    onEscalate: async () => 'x',
  });
  assert.deepEqual(delays, [100, 200]); // two backoffs before the success
  assert.equal(r.stdout, 'done');
});

// --- 18.4 escalate past the failure cap ---

test('rate-limit past the failure cap escalates rather than spinning', async () => {
  const op = async () => ({ stderr: '429 too many requests' });
  const delays = [];
  let info = null;
  const r = await runWithResilience(op, {
    maxRateLimitRetries: 3,
    baseMs: 10,
    sleep: async (ms) => delays.push(ms),
    onEscalate: async (i) => ((info = i), 'human says stop'),
  });
  assert.equal(r.escalated, true);
  assert.equal(info.kind, 'rate_limit');
  assert.equal(delays.length, 3); // backed off 3 times, then escalated
  assert.equal(r.answer, 'human says stop');
});

test('a clean success on the first try returns immediately with no sleep or escalation', async () => {
  const delays = [];
  let escalated = false;
  const r = await runWithResilience(async () => ({ stdout: 'ok', code: 0 }), {
    sleep: async (ms) => delays.push(ms),
    onEscalate: async () => ((escalated = true), 'x'),
  });
  assert.equal(r.stdout, 'ok');
  assert.equal(delays.length, 0);
  assert.equal(escalated, false);
});

test('a thrown error is classified too (transient throw retried, hard throw returned)', async () => {
  let calls = 0;
  const op = async () => {
    calls++;
    if (calls === 1) throw new Error('429 rate limited');
    return { stdout: 'recovered', code: 0 };
  };
  const r = await runWithResilience(op, { baseMs: 1, sleep: async () => {}, onEscalate: async () => 'x' });
  assert.equal(r.stdout, 'recovered');
});
