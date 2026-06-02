import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrchestrator, runMain, prepareRun } from '../src/main.js';
import { runLoop } from '../src/loop.js';
import { validateConfig, sanitizeEnv } from '../src/config.js';

// v4 capstone: the phase-driven loop. The worker self-drives and self-reports via
// STATUS; codex is the checkpoint EXAMINER — invoked ONLY at checkpoints/blocks,
// never on a plain WORKING turn (the token win). Driven by a scripted fake spawn.

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const BIN = { claude: 'CLAUDE_BIN', codex: 'CODEX_BIN', taskMaster: 'TM_BIN' };
const ok = (over = {}) => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...over });

function claudeStream(finalText) {
  return (
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: finalText }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: finalText, num_turns: 1, session_id: 's1' }),
    ].join('\n') + '\n'
  );
}

function makeFake(calls, { worker, verdicts }) {
  let w = 0;
  let c = 0;
  const next = (a, i) => a[Math.min(i, a.length - 1)];
  return async (bin, args, opts = {}) => {
    calls.push({ bin, args, env: opts.env });
    if (bin === BIN.claude) return ok({ stdout: claudeStream(next(worker, w++)) });
    if (bin === BIN.codex) {
      const o = args.indexOf('-o');
      fs.writeFileSync(args[o + 1], JSON.stringify(next(verdicts, c++)), 'utf8');
      return ok({ stdout: '{}' });
    }
    if (bin === 'git') {
      if (args[0] === 'ls-files') return ok({ stdout: 'casiocalc/engine.py\n' });
      if (args[0] === 'diff' && args.includes('--name-only')) return ok({ stdout: 'casiocalc/engine.py\n' });
      if (args[0] === 'diff') return ok({ stdout: '1 file changed, 3 insertions(+)\n' });
      return ok({ stdout: 'h\n' });
    }
    return ok(); // npm test, etc.
  };
}

function build(tmp, runProcess, reporter, opts = {}) {
  const config = validateConfig({ logDir: tmp, testCommand: ['npm', 'test'] });
  const env = sanitizeEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-proj-secret' });
  const { deps } = buildOrchestrator({
    config,
    binaries: BIN,
    cwd: tmp,
    env,
    runId: 'v4',
    runProcess,
    logger: { runDir: path.join(tmp, 'v4'), logTurn: () => {} },
    askHuman: async () => 'continue',
    reporter,
    ...opts,
  });
  return { deps, env };
}

test('WORKING auto-continues with NO codex call; CHECKPOINT triggers codex verify; PROJECT_COMPLETE ends', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-'));
  try {
    const calls = [];
    const runProcess = makeFake(calls, {
      worker: [
        'implemented part of the engine.\nSTATUS: WORKING',
        'engine done, tests pass.\nSTATUS: CHECKPOINT_REACHED Phase 1 engine',
        'whole PRD implemented.\nSTATUS: PROJECT_COMPLETE',
      ],
      verdicts: [{ accept: true, assessment: 'real & tested', findings: [], fix_tasks: [], report: 'Phase 1 verified' }],
    });
    const rep = { workerEvent: () => {}, checkpoint: [], done: () => {}, taskStart: () => {}, turn: () => {} };
    rep.checkpoint = [];
    const reporter = { ...rep, checkpoint: (c) => rep.checkpoint.push(c) };

    const { deps } = build(tmp, runProcess, reporter);
    const workerInstr = [];
    const realWorker = deps.runWorkerTurn;
    deps.runWorkerTurn = async (a) => {
      workerInstr.push({ instruction: a.instruction, sessionId: a.sessionId });
      return realWorker(a);
    };

    const r = await runLoop(deps);

    assert.equal(r.reason, 'done'); // PROJECT_COMPLETE
    // codex invoked ONLY at the checkpoint — NOT on the WORKING turn (the token win)
    assert.equal(calls.filter((c) => c.bin === BIN.codex).length, 1);
    assert.match(workerInstr[1].instruction, /continue/i); // WORKING -> auto-continued
    assert.match(workerInstr[2].instruction, /PASSED|proceed/i); // checkpoint passed -> proceed
    assert.equal(workerInstr[2].sessionId, null); // fresh worker session per phase
    assert.equal(rep.checkpoint.length, 1);
    assert.equal(rep.checkpoint[0].decision.accept, true);
    // no *_API_KEY ever reaches a child
    for (const c of calls) assert.ok(!Object.keys(c.env ?? {}).some((k) => k.toUpperCase().endsWith('_API_KEY')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a checkpoint REJECT relays the required fixes to the worker (catches faked functionality)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4r-'));
  try {
    const calls = [];
    const runProcess = makeFake(calls, {
      worker: ['claims done.\nSTATUS: CHECKPOINT_REACHED Phase 1', 'really fixed it.\nSTATUS: PROJECT_COMPLETE'],
      verdicts: [{ accept: false, assessment: 'sum is mocked', findings: [{ severity: 'blocker', detail: 'mock', evidence: 'engine.py returns a constant' }], fix_tasks: [{ title: 'implement sum for real', description: 'no mock' }], report: 'sum is faked' }],
    });
    const { deps } = build(tmp, runProcess, undefined);
    const workerInstr = [];
    const realWorker = deps.runWorkerTurn;
    deps.runWorkerTurn = async (a) => {
      workerInstr.push(a.instruction);
      return realWorker(a);
    };
    await runLoop(deps);
    assert.match(workerInstr[1], /did NOT pass/i);
    assert.match(workerInstr[1], /implement sum for real/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runMain refuses to run when the subscription probe fails, and never passes an API key to a child', async () => {
  const seenEnvs = [];
  const runProcess = async (bin, args, opts = {}) => {
    seenEnvs.push(opts.env ?? {});
    return { code: 1, signal: null, stdout: '', stderr: 'unauthorized', timedOut: false, error: null };
  };
  await assert.rejects(
    runMain({
      configOverride: { binaries: { claude: 'C', codex: 'D', taskMaster: 'T' }, testCommand: null },
      baseEnv: { PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-secret' },
      runProcess,
      runId: 'probe-fail',
    }),
    /subscription|not ready|login/i,
  );
  assert.ok(seenEnvs.length >= 1);
  for (const e of seenEnvs) {
    assert.ok(!Object.keys(e).some((k) => k.toUpperCase().endsWith('_API_KEY')), 'probe must use a sanitized env');
  }
});

test('prepareRun with requireCodex:false succeeds when only claude is up (claude-only commands skip codex)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
  try {
    const calls = [];
    const runProcess = async (bin, args) => {
      calls.push(bin);
      if (bin === 'C') return { code: 0, signal: null, stdout: 'OK', stderr: '', timedOut: false, error: null };
      // codex would FAIL auth, and `where`/`which` lookups succeed
      if (bin === 'D') return { code: 1, signal: null, stdout: '', stderr: 'token invalidated', timedOut: false, error: null };
      return { code: 0, signal: null, stdout: bin === 'where' || bin === 'which' ? 'x' : '', stderr: '', timedOut: false, error: null };
    };
    const r = await prepareRun({
      cwd: tmp,
      configOverride: { binaries: { claude: 'C', codex: 'D', taskMaster: 'T' }, testCommand: null },
      baseEnv: { PATH: 'p' },
      runProcess,
      requireCodex: false,
    });
    assert.ok(r.binaries.claude === 'C');
    assert.ok(!calls.includes('D'), 'codex (D) must never be probed when requireCodex:false');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Task 19.2: Loop advances across three sequential phases with no human input ---
test('loop advances across three sequential phases (two checkpoints + PROJECT_COMPLETE) with no human input', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-3p-'));
  try {
    const calls = [];
    const runProcess = makeFake(calls, {
      worker: [
        'implementing phase 1.\nSTATUS: WORKING',
        'phase 1 complete.\nSTATUS: CHECKPOINT_REACHED Phase 1 foundation',
        'implementing phase 2.\nSTATUS: WORKING',
        'phase 2 complete.\nSTATUS: CHECKPOINT_REACHED Phase 2 supervisor',
        'all phases done.\nSTATUS: PROJECT_COMPLETE',
      ],
      verdicts: [
        { accept: true, assessment: 'foundation verified', findings: [], fix_tasks: [], report: 'Phase 1 ok' },
        { accept: true, assessment: 'supervisor verified', findings: [], fix_tasks: [], report: 'Phase 2 ok' },
      ],
    });
    const { deps } = build(tmp, runProcess, undefined);

    const workerCalls = [];
    const realWorker = deps.runWorkerTurn;
    deps.runWorkerTurn = async (a) => {
      workerCalls.push({ sessionId: a.sessionId, instruction: a.instruction });
      return realWorker(a);
    };

    const r = await runLoop(deps);

    assert.equal(r.reason, 'done');
    assert.equal(r.turns, 5);
    // codex invoked ONLY at the two checkpoints — WORKING turns never touch codex
    assert.equal(calls.filter((c) => c.bin === BIN.codex).length, 2);
    // session resets to null after each checkpoint pass (fresh worker per phase)
    assert.equal(workerCalls[2].sessionId, null, 'session resets after Phase 1 checkpoint');
    assert.equal(workerCalls[4].sessionId, null, 'session resets after Phase 2 checkpoint');
    // proceed instructions relayed after each passed checkpoint
    assert.match(workerCalls[2].instruction, /PASSED|[Pp]roceed/);
    assert.match(workerCalls[4].instruction, /PASSED|[Pp]roceed/);
    // zero *_API_KEY in every child env across the whole three-phase run
    for (const c of calls) {
      assert.ok(
        !Object.keys(c.env ?? {}).some((k) => k.toUpperCase().endsWith('_API_KEY')),
        `API key leaked to ${c.bin}`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- Task 19.5: Zero-API-call and complete-transcript audit ---
test('complete per-turn transcript is written to disk and no *_API_KEY reaches any child process', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-audit-'));
  try {
    const calls = [];
    const runProcess = makeFake(calls, {
      worker: [
        'phase 1 done.\nSTATUS: CHECKPOINT_REACHED Phase 1 foundation',
        'all done.\nSTATUS: PROJECT_COMPLETE',
      ],
      verdicts: [{ accept: true, assessment: 'verified', findings: [], fix_tasks: [], report: 'Phase 1 ok' }],
    });
    // Use the REAL logger (no-op override omitted) so transcript files hit disk
    const config = validateConfig({ logDir: path.join(tmp, 'runs'), testCommand: ['npm', 'test'] });
    const env = sanitizeEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-proj-secret' });
    const { deps, runDir } = buildOrchestrator({
      config,
      binaries: BIN,
      cwd: tmp,
      env,
      runId: 'audit-run',
      runProcess,
      askHuman: async () => 'continue',
    });

    await runLoop(deps);

    // Per-turn transcript exists on disk with at least one Turn entry
    const transcriptPath = path.join(runDir, 'transcript.md');
    assert.ok(fs.existsSync(transcriptPath), 'transcript.md must be written to disk');
    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    assert.match(transcript, /Turn \d+/, 'transcript must contain per-turn entries');

    // Per-turn artifact directory must exist for turn 1
    const turn1Dir = path.join(runDir, 'turn-0001');
    assert.ok(fs.existsSync(turn1Dir), 'turn-0001 artifact directory must exist');
    assert.ok(fs.existsSync(path.join(turn1Dir, 'worker_stream.jsonl')), 'worker_stream.jsonl must exist');
    assert.ok(fs.existsSync(path.join(turn1Dir, 'ground_truth.json')), 'ground_truth.json must exist');

    // Zero *_API_KEY across every child process invocation in the whole run
    for (const c of calls) {
      assert.ok(
        !Object.keys(c.env ?? {}).some((k) => k.toUpperCase().endsWith('_API_KEY')),
        `*_API_KEY leaked to ${c.bin} (env keys: ${Object.keys(c.env ?? {}).join(', ')})`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
