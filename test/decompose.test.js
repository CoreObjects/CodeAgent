import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decomposePrd } from '../src/decompose.js';

// Reusable PRD->tasks decomposition: drive `claude -p` directly (the verified
// path; NOT task-master's claude-code provider, which hangs on Windows) and wrap
// the emitted JSON array into a task-master tasks.json via assembleTasksJson.
// runProcess is injected so the unit test never spawns a real CLI.

const claudeEnvelope = (arr) => ({ code: 0, stdout: JSON.stringify({ result: JSON.stringify(arr) }), stderr: '', error: null });

test('drives claude on the PRD and returns a tagged tasks.json', async () => {
  const calls = [];
  const runProcess = async (bin, args) => {
    calls.push({ bin, args });
    return claudeEnvelope([
      { id: 1, title: 'Scaffold', description: 'set up', details: 'REQ-001', testStrategy: 't', priority: 'high', dependencies: [], status: 'pending', subtasks: [] },
      { id: 2, title: 'Engine', description: 'build', details: 'REQ-002', testStrategy: 't', priority: 'medium', dependencies: [1], status: 'pending', subtasks: [] },
    ]);
  };
  const out = await decomposePrd({ prdPath: '/repo/.taskmaster/docs/prd.md', claudeBin: 'CLAUDE', env: { X: '1' }, num: '2 to 4', runProcess, now: '2026-01-01T00:00:00.000Z' });

  assert.equal(out.master.tasks.length, 2);
  assert.equal(out.master.tasks[0].title, 'Scaffold');
  assert.deepEqual(out.master.tasks[1].dependencies, [1]);

  // it drove claude -p in Read-only headless JSON mode, naming the PRD and count.
  const { bin, args } = calls[0];
  assert.equal(bin, 'CLAUDE');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format') && args.includes('json'));
  assert.ok(args.includes('--allowedTools') && args.includes('Read'));
  const prompt = args[args.indexOf('-p') + 1];
  assert.match(prompt, /prd\.md/);
  assert.match(prompt, /2 to 4/);
});

test('throws when claude fails (never fabricates tasks)', async () => {
  const runProcess = async () => ({ code: 1, stdout: '', stderr: 'boom', error: null });
  await assert.rejects(
    decomposePrd({ prdPath: 'p', claudeBin: 'C', env: {}, runProcess }),
    /decompos|claude|boom/i,
  );
});

test('passes a timeout through to runProcess', async () => {
  let seen = null;
  const runProcess = async (_bin, _args, opts) => {
    seen = opts;
    return claudeEnvelope([{ id: 1, title: 'A', description: '', details: '', testStrategy: '', priority: 'low', dependencies: [], status: 'pending', subtasks: [] }]);
  };
  await decomposePrd({ prdPath: 'p', claudeBin: 'C', env: { A: '1' }, timeoutMs: 12345, runProcess });
  assert.equal(seen.timeoutMs, 12345);
  assert.deepEqual(seen.env, { A: '1' });
});
