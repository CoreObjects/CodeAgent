import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../src/loop.js';
import { classifyWorkerReport } from '../src/worker-report.js';

// v4: phase-driven loop. The worker self-reports via STATUS; routing is
// mechanical. codex (verifyCheckpoint / decideBlock) is invoked ONLY at
// checkpoints and blocks — never on a plain WORKING turn.

function makeDeps(finalTexts, { verifyVerdicts = [], blockActions = [], askAnswer = 'continue', stallGuard } = {}) {
  const calls = { worker: [], verify: [], block: [], asked: [], checkpoints: [], memoWrites: [] };
  let wi = 0;
  let vi = 0;
  let bi = 0;
  let memoContent = '';
  const next = (arr, i, dflt) => (i < arr.length ? arr[i] : dflt);
  const deps = {
    runWorkerTurn: async ({ instruction, sessionId }) => {
      calls.worker.push({ instruction, sessionId });
      return { sessionId: 's1', finalText: next(finalTexts, wi++, '') };
    },
    classifyReport: classifyWorkerReport,
    snapshotStart: async () => ({ head: 'h' }),
    collect: async () => ({ changedFiles: [] }),
    observeProgress: () => {},
    stallGuard: stallGuard ?? (() => null),
    verifyCheckpoint: async ({ checkpoint }) => {
      calls.verify.push(checkpoint);
      return next(verifyVerdicts, vi++, { accept: true, report: 'ok', fix_tasks: [] });
    },
    decideBlock: async ({ question }) => {
      calls.block.push(question);
      return next(blockActions, bi++, { kind: 'redirect', message: 'do X' });
    },
    memo: {
      read: () => memoContent,
      write: (m) => {
        memoContent = m;
        calls.memoWrites.push(m);
      },
    },
    askHuman: async (q) => {
      calls.asked.push(q);
      return askAnswer;
    },
    onCheckpoint: (c) => calls.checkpoints.push(c),
    beginInstruction: 'BEGIN: implement the PRD phase by phase.',
  };
  return { deps, calls };
}

test('PROJECT_COMPLETE returns done immediately (final review is the wrapper)', async () => {
  const { deps, calls } = makeDeps(['built everything.\nSTATUS: PROJECT_COMPLETE']);
  const r = await runLoop(deps);
  assert.equal(r.reason, 'done');
  assert.equal(calls.verify.length, 0);
});

test('a WORKING turn is auto-continued with NO codex call (the token win)', async () => {
  const { deps, calls } = makeDeps(['progress.\nSTATUS: WORKING', 'done.\nSTATUS: PROJECT_COMPLETE']);
  const r = await runLoop(deps);
  assert.equal(r.reason, 'done');
  assert.equal(calls.verify.length, 0); // codex never invoked on WORKING
  assert.equal(calls.block.length, 0);
  assert.match(calls.worker[1].instruction, /continue/i); // auto-continued
});

test('CHECKPOINT_REACHED -> codex verifies; on PASS, resets session and proceeds', async () => {
  const { deps, calls } = makeDeps(
    ['engine done.\nSTATUS: CHECKPOINT_REACHED Phase 1 engine', 'all done.\nSTATUS: PROJECT_COMPLETE'],
    { verifyVerdicts: [{ accept: true, report: 'engine verified', fix_tasks: [] }] },
  );
  await runLoop(deps);
  assert.deepEqual(calls.verify, ['Phase 1 engine']);
  assert.equal(calls.worker[1].sessionId, null); // fresh session per phase
  assert.match(calls.worker[1].instruction, /PASSED.*[Pp]roceed/s);
  assert.ok(calls.memoWrites.some((m) => /PASSED/.test(m)));
  assert.equal(calls.checkpoints[0].decision.accept, true);
});

test('CHECKPOINT_REACHED -> on REJECT, relays the required fixes and keeps the session', async () => {
  const { deps, calls } = makeDeps(
    ['claims done.\nSTATUS: CHECKPOINT_REACHED Phase 1', 'fixed.\nSTATUS: PROJECT_COMPLETE'],
    { verifyVerdicts: [{ accept: false, report: 'sum is mocked', fix_tasks: [{ title: 'implement sum for real', description: 'no mock' }] }] },
  );
  await runLoop(deps);
  assert.match(calls.worker[1].instruction, /did NOT pass/i);
  assert.match(calls.worker[1].instruction, /implement sum for real/);
  assert.equal(calls.worker[1].sessionId, 's1'); // same session — resume fixing
});

test('BLOCKED -> codex answers (redirect) relays the answer to the worker', async () => {
  const { deps, calls } = makeDeps(
    ['STATUS: BLOCKED: even or isEven?', 'STATUS: PROJECT_COMPLETE'],
    { blockActions: [{ kind: 'redirect', message: 'use isEven' }] },
  );
  await runLoop(deps);
  assert.deepEqual(calls.block, ['even or isEven?']);
  assert.equal(calls.worker[1].instruction, 'use isEven');
});

test('BLOCKED -> escalate asks the human and relays the answer to the worker', async () => {
  const { deps, calls } = makeDeps(
    ['STATUS: BLOCKED: pick A or B', 'STATUS: PROJECT_COMPLETE'],
    { blockActions: [{ kind: 'escalate', question: 'A or B?' }], askAnswer: 'B' },
  );
  await runLoop(deps);
  assert.deepEqual(calls.asked, ['A or B?']);
  assert.equal(calls.worker[1].instruction, 'B');
});

test('stall guard escalates; an "abort" answer stops the loop', async () => {
  const { deps } = makeDeps(['STATUS: WORKING'], { stallGuard: () => ({ escalate: true, question: 'stalled?' }), askAnswer: 'abort' });
  const r = await runLoop(deps);
  assert.equal(r.reason, 'abort');
});
