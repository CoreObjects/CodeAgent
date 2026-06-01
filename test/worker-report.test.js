import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWorkerReport } from '../src/worker-report.js';

// v4: the worker self-reports its state with a STATUS marker at the end of its
// message. The orchestrator parses it MECHANICALLY (no LLM) to route cheaply:
// WORKING -> auto-continue (no codex); CHECKPOINT_REACHED -> codex verify;
// BLOCKED -> codex/human; PROJECT_COMPLETE -> final acceptance.

test('parses CHECKPOINT_REACHED with its name', () => {
  assert.deepEqual(classifyWorkerReport('did the engine work.\n\nSTATUS: CHECKPOINT_REACHED Phase 1 — engine core'), {
    status: 'checkpoint',
    detail: 'Phase 1 — engine core',
  });
});

test('parses WORKING (mid-phase, will be auto-continued)', () => {
  assert.equal(classifyWorkerReport('made progress on the parser.\nSTATUS: WORKING').status, 'working');
});

test('parses BLOCKED with the question', () => {
  assert.deepEqual(classifyWorkerReport('STATUS: BLOCKED: should the public API be isEven or even?'), {
    status: 'blocked',
    detail: 'should the public API be isEven or even?',
  });
});

test('parses PROJECT_COMPLETE -> done', () => {
  assert.equal(classifyWorkerReport('everything is built and tested.\nSTATUS: PROJECT_COMPLETE').status, 'done');
});

test('no marker -> conservatively WORKING (keep going, never falsely "done")', () => {
  assert.equal(classifyWorkerReport('I read some files and edited code.').status, 'working');
  assert.equal(classifyWorkerReport('').status, 'working');
  assert.equal(classifyWorkerReport(null).status, 'working');
});

test('the LAST STATUS marker wins (claude may mention STATUS in passing)', () => {
  const text = 'I will report STATUS: WORKING as I go.\n...\nSTATUS: CHECKPOINT_REACHED Phase 2';
  assert.deepEqual(classifyWorkerReport(text), { status: 'checkpoint', detail: 'Phase 2' });
});
