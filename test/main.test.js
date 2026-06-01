import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrchestrator, runMain } from '../src/main.js';
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
