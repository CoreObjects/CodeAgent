import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrchestrator, runMain } from '../src/main.js';
import { runLoop } from '../src/loop.js';
import { validateConfig, sanitizeEnv } from '../src/config.js';
import { createRunLogger } from '../src/logging.js';

// REQ — Phase 5 capstone (task 19): assemble every real module into runLoop and
// prove the closed loop end-to-end with a fully scripted fake spawn. Two drills:
//   (1) injected false-done — worker claims done, ground truth shows no diff +
//       failing tests, codex returns redirect+fake_done_flag, loop does NOT mark
//       the task done (REQ-005/006/008).
//   (2) escalation round-trip — codex escalates, the loop pauses, the human's
//       answer is routed back to CODEX (not the worker) (REQ-011/014).
// Plus: complete per-turn transcript on disk (REQ-013) and no *_API_KEY ever
// reaching a child process (REQ-012).

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SCHEMA = path.join(ROOT, 'schema', 'codex-decision.schema.json');

const BIN = { claude: 'CLAUDE_BIN', codex: 'CODEX_BIN', taskMaster: 'TM_BIN' };

function claudeStream({ sessionId = 's1', text = '' }) {
  return (
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: text, num_turns: 1, session_id: sessionId }),
    ].join('\n') + '\n'
  );
}

const ok = (over = {}) => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, ...over });

const complete = (file) => ({
  verdict: 'task_complete',
  assessment: `Diff present (${file}) and tests pass; requirement met.`,
  cited_evidence: [
    { source: 'git_diff', observation: `${file} changed` },
    { source: 'test_exit_code', observation: '0' },
  ],
  fake_done_flag: false,
  updated_memo: `task done: ${file}`,
});

const redirectFakeDone = {
  verdict: 'redirect',
  assessment: 'Worker claims completion but the diff is empty and tests fail.',
  message_to_claude: 'No code was written (empty diff) and tests fail. Actually implement it and run the tests for real.',
  cited_evidence: [
    { source: 'git_diff', observation: 'empty diff' },
    { source: 'test_exit_code', observation: '1' },
  ],
  fake_done_flag: true,
  updated_memo: 'caught a fake done on task 2; awaiting a real implementation',
};

const escalateScope = {
  verdict: 'escalate',
  assessment: 'The public predicate name is not settled by the PRD.',
  escalation_question: 'Name the predicate isEven or even?',
  escalation_category: 'scope_product',
  cited_evidence: [{ source: 'task_requirement', observation: 'PRD does not specify the public name' }],
  updated_memo: 'awaiting human decision on the public API name',
};

// One scripted turn per entry; the fake advances after each codex call.
const PLAN = [
  { claim: 'Implemented sum in lib/math.js; tests pass.', changed: ['lib/math.js'], testExit: 0, decision: complete('lib/math.js') },
  { claim: 'All done — isEven implemented and all tests pass.', changed: [], testExit: 1, decision: redirectFakeDone },
  { claim: 'Now actually implemented isEven in lib/iseven.js.', changed: ['lib/iseven.js'], testExit: 0, decision: complete('lib/iseven.js') },
  { claim: 'I can start but the public name is ambiguous.', changed: [], testExit: 1, decision: escalateScope },
  { claim: 'Implemented the predicate as isEven per the human.', changed: ['lib/predicate.js'], testExit: 0, decision: complete('lib/predicate.js') },
];

const TASKS = [
  { id: '1', title: 'sum', description: 'add sum' },
  { id: '2', title: 'isEven', description: 'add isEven' },
  { id: '3', title: 'predicate', description: 'add a predicate' },
];

function makeFakeRunProcess(calls) {
  let turn = 0;
  let nextIdx = 0;
  return async (bin, args, opts = {}) => {
    calls.push({ bin, args, env: opts.env });
    const p = PLAN[Math.min(turn, PLAN.length - 1)];

    if (bin === BIN.taskMaster) {
      if (args[0] === 'next') {
        const task = TASKS[nextIdx] ?? null;
        nextIdx += 1;
        return ok({ stdout: JSON.stringify({ task }) });
      }
      if (args[0] === 'set-status') return ok();
      return ok();
    }
    if (bin === BIN.claude) {
      return ok({ stdout: claudeStream({ text: p.claim }) });
    }
    if (bin === BIN.codex) {
      const o = args.indexOf('-o');
      const decisionFile = args[o + 1];
      fs.writeFileSync(decisionFile, JSON.stringify(p.decision), 'utf8');
      turn += 1; // a codex call ends the turn
      return ok({ stdout: '{}' });
    }
    if (bin === 'git') {
      if (args[0] === 'rev-parse') return ok({ stdout: `head${turn}\n` });
      if (args[0] === 'status') return ok({ stdout: '' });
      if (args[0] === 'diff' && args.includes('--name-only')) return ok({ stdout: p.changed.join('\n') });
      if (args[0] === 'diff') return ok({ stdout: p.changed.length ? '1 file changed, 3 insertions(+)\n' : '' });
      return ok();
    }
    if (bin === 'npm') return ok({ code: p.testExit }); // the configured test command
    return ok();
  };
}

test('closed-loop milestone: false-done caught (not marked done) + escalation routed to codex + full transcript + no API keys', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-'));
  try {
    const config = validateConfig({ logDir: tmp, testCommand: ['npm', 'test'] });
    const env = sanitizeEnv({ PATH: 'p', PYTHONUTF8: '1', ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-proj-secret' });
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'sanitizeEnv must strip the API key');

    const calls = [];
    const runProcess = makeFakeRunProcess(calls);

    const setStatus = [];
    const claudeInstructions = [];
    const recorded = [];
    const realLogger = createRunLogger({ baseDir: tmp, runId: 'milestone' });
    const logger = {
      runDir: realLogger.runDir,
      logTurn: (t) => {
        recorded.push(t);
        realLogger.logTurn(t);
      },
    };
    const askedQuestions = [];

    const { deps, runDir } = buildOrchestrator({
      config,
      binaries: BIN,
      schemaPath: SCHEMA,
      cwd: tmp,
      env,
      runId: 'milestone',
      runProcess,
      logger,
      askHuman: async (q) => {
        askedQuestions.push(q);
        return 'isEven';
      },
    });

    // observe set-status + relayed worker instructions through the deps boundary.
    const realSetStatus = deps.setStatus;
    deps.setStatus = async (id, status) => {
      setStatus.push([id, status]);
      return realSetStatus(id, status);
    };
    const realWorker = deps.runWorkerTurn;
    deps.runWorkerTurn = async (a) => {
      claudeInstructions.push(a.instruction);
      return realWorker(a);
    };

    const result = await runLoop(deps);

    // --- closed loop completed across all three tasks ---
    assert.equal(result.reason, 'done');
    assert.deepEqual(setStatus, [['1', 'done'], ['2', 'done'], ['3', 'done']]);

    // --- DRILL 1: injected false-done caught, task NOT marked done that turn ---
    const falseDoneTurn = recorded[1]; // task 2, turn 1
    assert.equal(falseDoneTurn.codexDecision.verdict, 'redirect');
    assert.equal(falseDoneTurn.codexDecision.fake_done_flag, true);
    assert.ok(falseDoneTurn.codexDecision.cited_evidence.length >= 1, 'redirect must cite evidence');
    // the orchestrator's own eyes saw the divergence the worker tried to hide:
    assert.equal(falseDoneTurn.evidenceDigest.divergence_hints.claimedDoneButNoDiff, true);
    // and the redirect message was relayed verbatim to the worker on the next turn:
    assert.ok(claudeInstructions.includes(redirectFakeDone.message_to_claude));

    // --- DRILL 2: escalation paused and routed the human answer back to CODEX ---
    assert.deepEqual(askedQuestions, ['Name the predicate isEven or even?']);
    // codex's prompt on the resumed turn (task 3, turn 2) carried the human answer via the memo:
    const resumedPrompt = recorded[4].codexPrompt;
    assert.match(resumedPrompt, /isEven/);
    // ...and the worker was NOT handed the human's words directly:
    assert.ok(!claudeInstructions.some((i) => i.includes('Name the predicate')));

    // --- transcript on disk for every turn (REQ-013) ---
    assert.equal(recorded.length, 5);
    assert.ok(fs.existsSync(path.join(runDir, 'transcript.md')));
    const transcript = fs.readFileSync(path.join(runDir, 'transcript.md'), 'utf8');
    assert.match(transcript, /redirect/);
    assert.match(transcript, /task_complete/);
    assert.ok(fs.existsSync(path.join(runDir, 'turn-0002', 'codex_decision.json')));

    // --- no *_API_KEY ever reached a child process (REQ-012) ---
    for (const c of calls) {
      const keys = Object.keys(c.env ?? {});
      assert.ok(!keys.some((k) => k.toUpperCase().endsWith('_API_KEY')), `leaked key to ${c.bin}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('runMain refuses to run when the subscription probe fails, and never passes an API key to a child', async () => {
  const seenEnvs = [];
  const runProcess = async (bin, args, opts = {}) => {
    seenEnvs.push(opts.env ?? {});
    // probe replies non-zero -> subscription auth unavailable
    return { code: 1, signal: null, stdout: '', stderr: 'unauthorized', timedOut: false, error: null };
  };
  await assert.rejects(
    runMain({
      configOverride: { binaries: { claude: 'C', codex: 'D', taskMaster: 'T' }, testCommand: null },
      baseEnv: { PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-secret' },
      runProcess,
      runId: 'probe-fail',
    }),
    /subscription|probe/i,
  );
  assert.ok(seenEnvs.length >= 1);
  for (const e of seenEnvs) {
    assert.ok(!Object.keys(e).some((k) => k.toUpperCase().endsWith('_API_KEY')), 'probe must use a sanitized env');
  }
});
