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

// REQ-016 — the loop feeds each turn's ground truth to the non-progress guard and
// turns its escalate signal into a human pause routed back to codex (never the worker).

test('feeds each turn ground truth to observeProgress', async () => {
  const { deps, calls } = makeDeps([
    { verdict: 'continue', message_to_claude: 'x', updated_memo: 'm' },
    { verdict: 'task_complete', updated_memo: 'm' },
  ]);
  const observed = [];
  deps.observeProgress = (gt) => observed.push(gt);
  await runLoop(deps);
  assert.equal(observed.length, 2);
  assert.deepEqual(observed[0], { changedFiles: [] }); // exactly what collect() returned
});

test('pre-turn guard escalation routes the human answer back to codex via the memo, not the worker', async () => {
  const { deps, calls } = makeDeps([{ verdict: 'task_complete', updated_memo: 'm' }]);
  let fired = false;
  deps.preTurnGuard = () => (fired ? null : ((fired = true), { escalate: true, question: 'Stalled — continue?' }));
  deps.askHuman = async (q) => {
    calls.askHuman.push(q);
    return 'try a different approach';
  };
  await runLoop(deps);
  assert.deepEqual(calls.askHuman, ['Stalled — continue?']);
  // answer went into the memo (codex's channel)...
  assert.ok(calls.memoWrites.some((m) => m.includes('try a different approach')));
  // ...and NOT into the worker's instruction stream.
  assert.ok(!calls.worker.some((w) => w.includes('try a different approach')));
});

test('pre-turn guard escalation honoring an explicit abort stops the loop before running the worker', async () => {
  const { deps, calls } = makeDeps([{ verdict: 'task_complete', updated_memo: 'm' }]);
  deps.preTurnGuard = () => ({ escalate: true, question: 'Stalled hard — continue or abort?' });
  deps.askHuman = async () => 'abort please';
  const r = await runLoop(deps);
  assert.equal(r.reason, 'abort');
  assert.equal(calls.worker.length, 0); // aborted at the guard, before the worker ran
});

test('calls onTaskStart once per task with an incrementing index (for the live reporter)', async () => {
  const { deps } = makeDeps(
    [
      { verdict: 'task_complete', updated_memo: 'a' },
      { verdict: 'task_complete', updated_memo: 'b' },
    ],
    { tasks: [{ id: '1' }, { id: '2' }] },
  );
  const starts = [];
  deps.onTaskStart = (x) => starts.push(x);
  await runLoop(deps);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map((s) => s.taskIndex), [1, 2]);
  assert.equal(starts[0].task.id, '1');
});
