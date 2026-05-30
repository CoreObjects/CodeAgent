import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';

// REQ-007: verdict router — a pure mechanical switch. Reads ONLY verdict and the
// next-message / question fields it forwards. All judgment lives in codex.

const base = { assessment: 'x', cited_evidence: [{}], updated_memo: 'm', fake_done_flag: true };

test('continue forwards message_to_claude', () => {
  const a = route({ ...base, verdict: 'continue', message_to_claude: 'go on' });
  assert.equal(a.kind, 'continue');
  assert.equal(a.message, 'go on');
});

test('redirect forwards message_to_claude byte-for-byte', () => {
  const a = route({ ...base, verdict: 'redirect', message_to_claude: 'rewrite X exactly' });
  assert.equal(a.kind, 'redirect');
  assert.equal(a.message, 'rewrite X exactly');
});

test('task_complete maps to a payload-free action', () => {
  assert.equal(route({ ...base, verdict: 'task_complete' }).kind, 'task_complete');
});

test('escalate forwards escalation_question', () => {
  const a = route({ ...base, verdict: 'escalate', escalation_question: 'A or B?' });
  assert.equal(a.kind, 'escalate');
  assert.equal(a.question, 'A or B?');
});

test('abort maps to abort', () => {
  assert.equal(route({ ...base, verdict: 'abort' }).kind, 'abort');
});

test('an unknown verdict throws (default case)', () => {
  assert.throws(() => route({ ...base, verdict: 'bogus' }), /unknown verdict/i);
});

test('contract: router never reads assessment / cited_evidence / fake_done_flag', () => {
  // Getters that throw if the router touches judgment fields.
  const decision = {
    verdict: 'continue',
    message_to_claude: 'ok',
    get assessment() {
      throw new Error('router read assessment');
    },
    get cited_evidence() {
      throw new Error('router read cited_evidence');
    },
    get fake_done_flag() {
      throw new Error('router read fake_done_flag');
    },
  };
  assert.equal(route(decision).kind, 'continue'); // must not throw
});
