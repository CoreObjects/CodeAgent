import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as trunk from '../src/task-trunk.js';
import { taskMasterNext, taskMasterShow, taskMasterSetStatus } from '../src/task-trunk.js';

// REQ-010: task-master trunk wrapper — pure pass-through, no completion judgment.

const NEXT_JSON = JSON.stringify({ task: { id: '14', title: 'Logging', status: 'pending', dependencies: [] } });

test('taskMasterNext parses {task:{...}} into the task object', async () => {
  const run = async (bin, args) => {
    assert.deepEqual(args, ['next', '--format', 'json']);
    return { code: 0, stdout: NEXT_JSON, stderr: '', timedOut: false, error: null };
  };
  const t = await taskMasterNext({ runProcess: run, taskMasterBin: 'task-master' });
  assert.equal(t.id, '14');
});

test('taskMasterNext returns null when there is no next task', async () => {
  const run = async () => ({ code: 0, stdout: JSON.stringify({ task: null }), stderr: '', timedOut: false, error: null });
  assert.equal(await taskMasterNext({ runProcess: run, taskMasterBin: 'task-master' }), null);
});

test('taskMasterNext returns null on unparseable output', async () => {
  const run = async () => ({ code: 0, stdout: 'not json (a box table)', stderr: '', timedOut: false, error: null });
  assert.equal(await taskMasterNext({ runProcess: run, taskMasterBin: 'task-master' }), null);
});

test('taskMasterShow fetches a task by id via --format json', async () => {
  let captured;
  const run = async (bin, args) => {
    captured = args;
    return { code: 0, stdout: JSON.stringify({ task: { id: '3', title: 'Config' } }), stderr: '', timedOut: false, error: null };
  };
  const t = await taskMasterShow({ runProcess: run, taskMasterBin: 'task-master' }, '3');
  assert.equal(t.id, '3');
  assert.deepEqual(captured, ['show', '3', '--format', 'json']);
});

test('taskMasterSetStatus passes id/status through and reports exit code only', async () => {
  let captured;
  const run = async (bin, args) => {
    captured = args;
    return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
  };
  const r = await taskMasterSetStatus({ runProcess: run, taskMasterBin: 'task-master' }, '5', 'done');
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.deepEqual(captured, ['set-status', '--id=5', '--status=done']);
});

test('contract: module exports only next/show/setStatus (no completion judgment)', () => {
  assert.deepEqual(Object.keys(trunk).sort(), ['taskMasterNext', 'taskMasterSetStatus', 'taskMasterShow']);
});
