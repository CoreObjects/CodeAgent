import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTasksJson } from '../src/task-gen.js';

// REQ-019 / subtask 4.3: the verified direct-claude task-generation path.
// assembleTasksJson is the pure core: claude's JSON array -> task-master tasks.json.

const NOW = '2026-01-01T00:00:00.000Z';

test('wraps a task array in the task-master tagged structure', () => {
  const out = assembleTasksJson('[{"id":1,"title":"A"}]', { now: NOW });
  assert.ok(Array.isArray(out.master.tasks));
  assert.equal(out.master.tasks[0].title, 'A');
  assert.equal(out.master.metadata.created, NOW);
});

test('normalizes each task: status pending, empty subtasks, integer deps, default priority', () => {
  const out = assembleTasksJson('[{"id":"2","title":"B","dependencies":["1"]}]', { now: NOW });
  const t = out.master.tasks[0];
  assert.equal(t.id, 2);
  assert.equal(t.status, 'pending');
  assert.deepEqual(t.subtasks, []);
  assert.deepEqual(t.dependencies, [1]);
  assert.equal(t.priority, 'medium');
});

test('strips a ```json code fence if claude wraps the array', () => {
  const out = assembleTasksJson('```json\n[{"id":1,"title":"C"}]\n```', { now: NOW });
  assert.equal(out.master.tasks[0].title, 'C');
});

test('a tag is valid for task-master: master.tasks is an array', () => {
  const out = assembleTasksJson('[{"id":1,"title":"x"}]', { now: NOW });
  assert.ok(Array.isArray(out.master.tasks));
});

test('throws when the payload is not a JSON array', () => {
  assert.throws(() => assembleTasksJson('{"not":"an array"}', { now: NOW }), /array/i);
});
