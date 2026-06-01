import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerBootstrap } from '../src/worker-bootstrap.js';

// REQ-015: worker bootstrap prompt — role + trunk reference + test command,
// WITHOUT imposing a rigid output schema (Claude Code keeps its native tool loop).

test('states the worker role and references the task-master trunk', () => {
  const p = buildWorkerBootstrap({ testCommand: ['npm', 'test'] });
  assert.match(p, /implement/i);
  assert.match(p, /task-master/);
});

test('names the configured test command', () => {
  assert.match(buildWorkerBootstrap({ testCommand: ['node', '--test'] }), /node --test/);
});

test('omits the test sentence when no test command is configured', () => {
  const p = buildWorkerBootstrap({ testCommand: null });
  assert.doesNotMatch(p, /test command/i);
});

test('tells the worker to wire acceptance criteria (coverage etc.) into the standard test command', () => {
  const p = buildWorkerBootstrap({ testCommand: ['python', '-m', 'pytest', '-q'] });
  assert.match(p, /standard test command/i);
  assert.match(p, /coverage|addopts/i);
});

test('warns that GUI tests must be headless / non-blocking (no modal exec, offscreen)', () => {
  const p = buildWorkerBootstrap({ testCommand: ['python', '-m', 'pytest', '-q'] });
  assert.match(p, /headless|offscreen/i);
  assert.match(p, /exec\(\)|modal|hang/i);
});

test('drives phase-by-phase and defines the STATUS self-report protocol', () => {
  const p = buildWorkerBootstrap({ testCommand: ['python', '-m', 'pytest', '-q'] });
  assert.match(p, /phase by phase/i); // self-drive a whole phase
  assert.match(p, /STATUS: CHECKPOINT_REACHED/);
  assert.match(p, /STATUS: WORKING/);
  assert.match(p, /STATUS: BLOCKED/);
  assert.match(p, /STATUS: PROJECT_COMPLETE/);
  assert.match(p, /real functionality/i); // no faked results
});

test('does not impose a rigid output schema (no output-format / json-schema constraint)', () => {
  const p = buildWorkerBootstrap({ testCommand: ['npm', 'test'] });
  assert.doesNotMatch(p, /output-format|respond with json|json schema|response format/i);
});
