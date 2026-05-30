// main.js — assembly + entry point (task 19)
// Wire every real module into runLoop. This file is the ONLY place the concrete
// collaborators meet; everything it composes is independently tested. The loop
// stays dumb plumbing — all judgment is codex's.
//
// Two public surfaces:
//   buildOrchestrator(...) — pure composition: returns runLoop `deps` with all
//                            adapters bound. Fully injectable (runProcess, logger,
//                            askHuman) so the closed loop is testable end-to-end.
//   runMain(...)           — CLI entry: load config, sanitize env, resolve the
//                            CLIs, assert subscription via the startup probe
//                            (refuse to run otherwise — NEVER inject an API key),
//                            then run the loop.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProcess as defaultRunProcess } from './proc.js';
import { validateConfig, sanitizeEnv, resolveAllBinaries, runStartupProbe } from './config.js';
import { runClaudeTurn } from './claude-runner.js';
import { snapshotStart as gtSnapshotStart, collect as gtCollect } from './ground-truth.js';
import { buildEvidenceDigest } from './evidence-digest.js';
import { runCodexSupervisor, assembleCodexPrompt } from './codex-supervisor.js';
import { createMemoStore } from './memo-store.js';
import { buildCodexSystemPrompt } from './codex-prompt.js';
import { buildWorkerBootstrap } from './worker-bootstrap.js';
import { taskMasterNext, taskMasterSetStatus } from './task-trunk.js';
import { createRunLogger, redactSecrets } from './logging.js';
import { createEscalationChannel } from './escalation.js';
import { createProgressGuard } from './progress-guard.js';
import { runWithResilience, classifyFailure } from './resilience.js';
import { route } from './router.js';
import { runLoop } from './loop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const DEFAULT_SCHEMA_PATH = path.join(PROJECT_ROOT, 'schema', 'codex-decision.schema.json');

/** Render a task as the worker's first-turn instruction AND codex's GOAL. */
function renderTaskGoal(task, workerBootstrap) {
  const body = [
    `# Task ${task.id}: ${task.title ?? ''}`.trim(),
    task.description ? `\n${task.description}` : '',
    task.details ? `\n\n## Details\n${task.details}` : '',
    task.testStrategy ? `\n\n## Test strategy\n${task.testStrategy}` : '',
  ]
    .filter(Boolean)
    .join('');
  return `${workerBootstrap}\n\n${body}`;
}

// Resilience classifies ONLY thrown failures (a successful turn/decision is never
// re-judged by its text) — so a worker merely discussing "rate limits" can't
// trigger a spurious retry. A rate-limited claude turn throws (no session id);
// codex handles its own transient via re-ask-once inside runCodexSupervisor.
const throwOnlyClassify = (r) =>
  r instanceof Error ? classifyFailure({ message: r.message, stderr: r.stderr }) : 'none';

/**
 * Compose all collaborators into runLoop `deps`. Returns { deps, runDir, memoPath }.
 */
export function buildOrchestrator({
  config = validateConfig({}),
  binaries,
  schemaPath = DEFAULT_SCHEMA_PATH,
  cwd = process.cwd(),
  env,
  runId,
  runProcess = defaultRunProcess,
  logger,
  askHuman,
  systemPrompt,
  decisionFile,
  onWarn = () => {},
  sleep,
} = {}) {
  const log = logger ?? createRunLogger({ baseDir: config.logDir, runId });
  const runDir = log.runDir;
  fs.mkdirSync(runDir, { recursive: true });

  const memoPath = path.join(runDir, 'memo.md');
  const decisionPath = decisionFile ?? path.join(runDir, 'codex-decision.json');
  const memo = createMemoStore({ path: memoPath, maxChars: config.memoMaxChars, onWarn });
  const guard = createProgressGuard({ threshold: 3 });
  const role = systemPrompt ?? buildCodexSystemPrompt({ memoCap: config.memoMaxChars });
  const workerBootstrap = buildWorkerBootstrap({ testCommand: config.testCommand });

  // Human escalation channel: by default the console pause, recording each
  // exchange into the run transcript. Tests inject a fake askHuman.
  const askHumanFn =
    askHuman ??
    createEscalationChannel({
      record: ({ question, answer }) => {
        try {
          fs.appendFileSync(
            path.join(runDir, 'transcript.md'),
            `\n### ESCALATION\n- Q: ${redactSecrets(question)}\n- A: ${redactSecrets(answer)}\n`,
            'utf8',
          );
        } catch {
          /* transcript best-effort */
        }
      },
    }).askHuman;

  const resilienceOpts = {
    classify: throwOnlyClassify,
    sleep,
    onEscalate: async ({ kind, message }) =>
      askHumanFn(`Transient failure (${kind}): ${message} Continue waiting, retry later, or abort?`),
  };

  // --- adapters: each binds a tested module to the loop's dep contract ---

  const nextTask = () =>
    taskMasterNext({ runProcess, taskMasterBin: binaries.taskMaster, cwd, env });

  const setStatus = (id, status) =>
    taskMasterSetStatus({ runProcess, taskMasterBin: binaries.taskMaster, cwd, env }, id, status);

  const runWorkerTurn = async ({ instruction, sessionId }) => {
    const r = await runWithResilience(
      () =>
        runClaudeTurn({
          runProcess,
          claudeBin: binaries.claude,
          instruction,
          sessionId,
          permissionMode: config.permissionMode,
          allowedTools: config.allowedTools,
          env,
          timeoutMs: config.timeouts.claudeTurnMs,
        }),
      resilienceOpts,
    );
    if (r && r.escalated) {
      // worker unreachable after retries — keep the loop alive; codex sees it as evidence.
      return {
        sessionId,
        finalText: `[worker unavailable: ${r.kind}] human said: ${r.answer}`,
        toolUseCalls: [],
        toolResults: [],
        resultEvent: null,
        terminationReason: 'escalated',
      };
    }
    return r;
  };

  const snapshotStart = () => gtSnapshotStart({ runProcess, cwd });

  const collect = (snapshot) =>
    gtCollect({ runProcess, cwd, snapshot, testCommand: config.testCommand });

  const buildDigest = ({ turn, groundTruth, task, turnIndex }) => {
    const { digest, json } = buildEvidenceDigest(
      { turn, groundTruth, task, turnIndex },
      { totalCap: config.digestMaxChars },
    );
    return { digest, json };
  };

  const decide = async ({ instructions, evidenceJson }) => {
    const r = await runWithResilience(
      () =>
        runCodexSupervisor({
          runProcess,
          codexBin: binaries.codex,
          schemaPath,
          decisionFile: decisionPath,
          instructions,
          evidenceJson,
          env,
          cwd,
          timeoutMs: config.timeouts.codexTurnMs,
        }),
      resilienceOpts,
    );
    if (r && r.escalated) {
      // supervisor unreachable after retries — synthesize an escalate so a human decides.
      return {
        decision: {
          verdict: 'escalate',
          assessment: `codex unreachable (${r.kind})`,
          escalation_question: `The supervisor was unreachable (${r.kind}); the human said: ${r.answer}. Continue, wait, or abort?`,
          escalation_category: 'judgment_human_would_want',
          cited_evidence: [{ source: 'tool_result', observation: `codex transient failure: ${r.kind}` }],
          updated_memo: memo.read(),
        },
      };
    }
    return r; // { decision, valid, reAsked }
  };

  const assemblePrompt = ({ goal, memo: memoText }) =>
    assembleCodexPrompt({ role, goal, memo: memoText, memoCap: config.memoMaxChars });

  const renderGoal = (task) => renderTaskGoal(task, workerBootstrap);

  // Per-task stall tracking: reset the mechanical counter on each task's first turn.
  const preTurnGuard = ({ task, taskTurns }) => {
    if (taskTurns === 1) guard.reset();
    return guard.shouldEscalate() ? { escalate: true, question: guard.question(task.id) } : null;
  };
  const observeProgress = (groundTruth) => guard.observe(groundTruth);

  const deps = {
    nextTask,
    setStatus,
    runWorkerTurn,
    snapshotStart,
    collect,
    buildDigest,
    decide,
    memo,
    assemblePrompt,
    renderGoal,
    route,
    logTurn: log.logTurn,
    askHuman: askHumanFn,
    preTurnGuard,
    observeProgress,
  };

  return { deps, runDir, memoPath };
}

function loadConfigFile(cwd) {
  const p = path.join(cwd, 'config', 'orchestrator.config.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function defaultRunId() {
  // main.js runs in a normal Node process (not the workflow sandbox), so Date is fine.
  return `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * CLI entry. Resolves config + binaries, asserts subscription auth via the
 * startup probe, then drives the loop. Throws (refusing to run) if the probe
 * fails — we never fall back to API-key auth.
 */
export async function runMain({
  runProcess = defaultRunProcess,
  cwd = process.cwd(),
  baseEnv = process.env,
  configOverride = null,
  schemaPath = DEFAULT_SCHEMA_PATH,
  runId = defaultRunId(),
  askHuman,
  logger,
} = {}) {
  const config = validateConfig(configOverride ?? loadConfigFile(cwd));
  const env = sanitizeEnv(baseEnv);
  const binaries = await resolveAllBinaries(config, runProcess);

  const probe = await runStartupProbe({
    runProcess,
    claudeBin: binaries.claude,
    codexBin: binaries.codex,
    env,
  });
  if (!probe.claude.ok || !probe.codex.ok) {
    throw new Error(
      'Startup probe failed — subscription auth is not available for ' +
        `${!probe.claude.ok ? 'claude ' : ''}${!probe.codex.ok ? 'codex' : ''}`.trim() +
        '. Refusing to run; this orchestrator never injects an API key.',
    );
  }

  const { deps, runDir } = buildOrchestrator({
    config,
    binaries,
    schemaPath,
    cwd,
    env,
    runId,
    runProcess,
    logger,
    askHuman,
  });
  const result = await runLoop(deps);
  return { ...result, runDir, binaries };
}

// Run as a script: `node src/main.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMain()
    .then((r) => {
      console.log(`\n[orchestrator] finished: ${r.reason} after ${r.turns} turns. Transcript: ${r.runDir}`);
    })
    .catch((err) => {
      console.error(`[orchestrator] ${err.message}`);
      process.exitCode = 1;
    });
}
