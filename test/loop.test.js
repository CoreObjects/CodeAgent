import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../src/loop.js';

// REQ-008: per-turn control loop. Pure orchestration — the only loop-side branches
// are turn-completion (inside runWorkerTurn), the verdict switch, and numeric guards
// that escalate. No deviation taxonomy. All collaborators are injected as fakes.

function makeDeps(decisions, { tasks = [{ id: '1', title: 'T' }] } = {}) {
  const calls = { worker: [], setStatus: [], askHuman: [], memoWrites: [], logged: [] };
  let taskI = 0;
  let decI = 0;
  let memoContent = '';
  const deps = {
    nextTask: async () => (taskI < tasks.length ? tasks[taskI++] : null),
    setStatus: async (id, status) => calls.setStatus.push([id, status]),
    runWorkerTurn: async ({ instruction }) => {
      calls.worker.push(instruction);
      return { sessionId: 's1', finalText: 'did stuff' };
    },
    snapshotStart: async () => ({ head: 'h0' }),
    collect: async () => ({ changedFiles: [] }),
    buildDigest: () => ({ json: '{}', digest: {} }),
    decide: async () => ({ decision: decisions[decI++] }),
    memo: {
      read: () => memoContent,
      write: (m) => {
        memoContent = m;
        calls.memoWrites.push(m);
      },
    },
    assemblePrompt: () => 'CODEX_PROMPT',
    renderGoal: (task) => `goal:${task.id}`,
    logTurn: (d) => calls.logged.push(d),
    askHuman: async (q) => {
      calls.askHuman.push(q);
      return 'continue';
    },
  };
  return { deps, calls };
}

test('runs turns until task_complete, marks done, advances, then ends', async () => {
  const { deps, calls } = makeDeps([
    { verdict: 'continue', message_to_claude: 'keep going', updated_memo: 'm1' },
    { verdict: 'task_complete', updated_memo: 'm2' },
  ]);
  const r = await runLoop(deps);
  assert.equal(r.reason, 'done');
  assert.equal(calls.worker.length, 2);
  assert.equal(calls.worker[0], 'goal:1'); // first turn instruction = the task goal
  assert.equal(calls.worker[1], 'keep going'); // second turn = relayed continue message
  assert.deepEqual(calls.setStatus, [['1', 'done']]);
});

test('redirect relays message_to_claude byte-for-byte as the next instruction', async () => {
  const { deps, calls } = makeDeps([
    { verdict: 'redirect', message_to_claude: 'rewrite X exactly', updated_memo: 'm' },
    { verdict: 'task_complete', updated_memo: 'm' },
  ]);
  await runLoop(deps);
  assert.equal(calls.worker[1], 'rewrite X exactly');
});

test('persists updated_memo every turn (including the continue turn)', async () => {
  const { deps, calls } = makeDeps([
    { verdict: 'continue', message_to_claude: 'x', updated_memo: 'memoA' },
    { verdict: 'task_complete', updated_memo: 'memoB' },
  ]);
  await runLoop(deps);
  assert.ok(calls.memoWrites.includes('memoA'));
  assert.ok(calls.memoWrites.includes('memoB'));
});

test('abort exits the loop cleanly with reason=abort', async () => {
  const { deps } = makeDeps([{ verdict: 'abort', updated_memo: '' }]);
  const r = await runLoop(deps);
  assert.equal(r.reason, 'abort');
});

test('escalate asks the human and routes the answer back via the memo, then continues', async () => {
  const { deps, calls } = makeDeps([
    { verdict: 'escalate', escalation_question: 'A or B?', updated_memo: 'm' },
    { verdict: 'task_complete', updated_memo: 'm2' },
  ]);
  await runLoop(deps);
  assert.deepEqual(calls.askHuman, ['A or B?']);
  assert.ok(calls.memoWrites.some((m) => m.includes('A or B') || m.includes('HUMAN')));
});

test('logs every turn', async () => {
  const { deps, calls } = makeDeps([
    { verdict: 'continue', message_to_claude: 'x', updated_memo: 'm' },
    { verdict: 'task_complete', updated_memo: 'm' },
  ]);
  await runLoop(deps);
  assert.equal(calls.logged.length, 2);
});

test('advances across multiple tasks', async () => {
  const { deps, calls } = makeDeps(
    [
      { verdict: 'task_complete', updated_memo: 'a' },
      { verdict: 'task_complete', updated_memo: 'b' },
    ],
    { tasks: [{ id: '1' }, { id: '2' }] },
  );
  const r = await runLoop(deps);
  assert.equal(r.reason, 'done');
  assert.deepEqual(calls.setStatus, [['1', 'done'], ['2', 'done']]);
});

test('numeric turn cap escalates to the human', async () => {
  // codex keeps saying continue; the cap must escalate rather than spin forever.
  const decisions = Array.from({ length: 5 }, () => ({ verdict: 'continue', message_to_claude: 'go', updated_memo: 'm' }));
  const { deps, calls } = makeDeps(decisions);
  deps.maxTurnsPerTask = 2;
  deps.askHuman = async () => 'abort'; // human chooses abort at the cap
  const r = await runLoop(deps);
  assert.equal(r.reason, 'abort');
  assert.ok(calls.worker.length <= 3);
});
