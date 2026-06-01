import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { buildProjectMap, collectProjectMap } from '../src/project-map.js';

// A bounded, every-turn project map that gives codex global awareness it lacks
// from the single-task evidence digest: the layout, per-task status, and codex's
// own accumulated integration notes. Pure; the async input collection is separate.

const tasks = [
  { id: '1', title: 'Scaffold', status: 'done' },
  { id: '2', title: 'Engine', status: 'in-progress' },
  { id: '3', title: 'UI', status: 'pending' },
];

test('summarizes layout, file count, and per-task status with a done count', () => {
  const map = buildProjectMap({ files: ['src/a.js', 'src/b.js', 'tests/a.test.js'], tasks });
  assert.match(map, /PROJECT MAP/);
  assert.match(map, /src\/ \(2\)/); // layout grouped by top dir with counts
  assert.match(map, /tests\/ \(1\)/);
  assert.match(map, /done 1\/3/); // 1 of 3 tasks done
  assert.match(map, /\[x\] 1 Scaffold/);
  assert.match(map, /\[>\] 2 Engine/); // in-progress marker
  assert.match(map, /\[ \] 3 UI/);
});

test('caps the file list and notes a remainder', () => {
  const files = Array.from({ length: 100 }, (_, i) => `src/f${i}.js`);
  const map = buildProjectMap({ files, tasks: [], caps: { maxFiles: 10 } });
  assert.match(map, /\+90 more/);
  assert.equal((map.match(/src\/f\d+\.js/g) || []).length, 10);
});

test('caps integration notes', () => {
  const map = buildProjectMap({ files: [], tasks: [], notes: 'x'.repeat(5000), caps: { notesChars: 100 } });
  assert.match(map, /Integration notes/);
  assert.ok(map.length < 600); // notes were clipped
});

test('handles empty inputs without throwing', () => {
  const map = buildProjectMap({});
  assert.match(map, /PROJECT MAP/);
  assert.match(map, /done 0\/0/);
});

test('collectProjectMap reads git ls-files and tasks.json from the repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmap-'));
  try {
    const tp = path.join(dir, '.taskmaster', 'tasks', 'tasks.json');
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, JSON.stringify({ master: { tasks: [{ id: 1, title: 'A', status: 'done' }, { id: 2, title: 'B', status: 'pending' }] } }));
    const runProcess = async (bin, args) => {
      assert.equal(bin, 'git');
      assert.deepEqual(args, ['ls-files']);
      return { code: 0, stdout: 'src/a.js\nsrc/b.js\n', stderr: '' };
    };
    const map = await collectProjectMap({ cwd: dir, runProcess });
    assert.match(map, /src\/ \(2\)/);
    assert.match(map, /done 1\/2/);
    assert.match(map, /\[x\] 1 A/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
