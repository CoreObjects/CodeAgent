import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressGuard } from '../src/progress-guard.js';

// REQ-016: mechanical non-progress guard. Increments ONLY on turns with an empty
// changed-file list AND an unchanged test exit code; resets on any change. At the
// threshold it escalates exactly once and takes NO other action — never
// auto-aborts, never judges correctness.

const noChange = { changedFiles: [], test: { exit_code: 1 } };
const filesChanged = { changedFiles: ['a.js'], test: { exit_code: 1 } };

test('counter increments only on no-change turns', () => {
  const g = createProgressGuard({ threshold: 3 });
  assert.equal(g.observe(noChange), 1);
  assert.equal(g.observe(noChange), 2);
  assert.equal(g.count, 2);
});

test('counter resets on any changed file', () => {
  const g = createProgressGuard({ threshold: 3 });
  g.observe(noChange);
  g.observe(noChange);
  assert.equal(g.observe(filesChanged), 0); // change -> reset
  assert.equal(g.count, 0);
});

test('counter resets when the test exit code changes', () => {
  const g = createProgressGuard({ threshold: 3 });
  g.observe({ changedFiles: [], test: { exit_code: 1 } }); // count 1 (first obs, no prior exit)
  g.observe({ changedFiles: [], test: { exit_code: 1 } }); // count 2 (exit unchanged)
  const c = g.observe({ changedFiles: [], test: { exit_code: 0 } }); // exit 1 -> 0 = progress
  assert.equal(c, 0);
});

test('shouldEscalate fires exactly once at the threshold, then latches until reset', () => {
  const g = createProgressGuard({ threshold: 3 });
  g.observe(noChange); // 1
  assert.equal(g.shouldEscalate(), false);
  g.observe(noChange); // 2
  assert.equal(g.shouldEscalate(), false);
  g.observe(noChange); // 3 -> threshold
  assert.equal(g.shouldEscalate(), true); // fires once
  g.observe(noChange); // 4 still stalled
  assert.equal(g.shouldEscalate(), false); // latched — no repeat spam
});

test('after a reset the guard can escalate again on a new stall streak', () => {
  const g = createProgressGuard({ threshold: 2 });
  g.observe(noChange);
  g.observe(noChange);
  assert.equal(g.shouldEscalate(), true);
  g.observe(filesChanged); // progress resets the latch
  assert.equal(g.shouldEscalate(), false);
  g.observe(noChange);
  g.observe(noChange);
  assert.equal(g.shouldEscalate(), true); // fires again on the new streak
});

test('question names the task and the stall count, asks the human to decide', () => {
  const g = createProgressGuard({ threshold: 2 });
  g.observe(noChange);
  g.observe(noChange);
  const q = g.question('7');
  assert.match(q, /7/);
  assert.match(q, /2/);
  assert.match(q, /progress/i);
});

test('reset() clears the counter and the latch', () => {
  const g = createProgressGuard({ threshold: 1 });
  g.observe(noChange);
  assert.equal(g.shouldEscalate(), true);
  g.reset();
  assert.equal(g.count, 0);
  assert.equal(g.shouldEscalate(), false);
});

test('default threshold is 3', () => {
  const g = createProgressGuard();
  g.observe(noChange);
  g.observe(noChange);
  assert.equal(g.shouldEscalate(), false); // not yet at 3
  g.observe(noChange);
  assert.equal(g.shouldEscalate(), true);
});
