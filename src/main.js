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
import { runWithRecovery, classifyFailure } from './resilience.js';
import { ensureWorkerSettings } from './worker-permissions.js';
import { detectTestCommand } from './detect-test.js';
import { collectProjectMap } from './project-map.js';
import { buildAcceptancePrompt, runAcceptance, appendFixTasks, generateUsageDoc } from './acceptance.js';
import { runWithAcceptance } from './finalize.js';
import { buildLoginGuidance } from './onboarding.js';
import { route } from './router.js';
import { runLoop } from './loop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const DEFAULT_SCHEMA_PATH = path.join(PROJECT_ROOT, 'schema', 'codex-decision.schema.json');
const ACCEPTANCE_SCHEMA_PATH = path.join(PROJECT_ROOT, 'schema', 'acceptance.schema.json');

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
  reporter,
  totalTasks = 0,
  runNote = '', // prepended to every goal (e.g. "you are RESUMING…")
} = {}) {
  const log = logger ?? createRunLogger({ baseDir: config.logDir, runId });
  const runDir = log.runDir;
  fs.mkdirSync(runDir, { recursive: true });

  // codex's rolling memo lives at a STABLE project path (not under runs/<runId>/)
  // so a resumed run reloads codex's accumulated memory and continues, instead of
  // starting blind. This is the root-cause fix for "interrupted -> can't continue".
  const stateDir = path.join(cwd, '.prd2code');
  fs.mkdirSync(stateDir, { recursive: true });
  const memoPath = path.join(stateDir, 'memo.md');
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

  // Run-level recovery: long-wait on quota/network, give up after N -> clean exit
  // (resume later with memo/tasks intact). onWait surfaces the pause to the screen.
  const recoveryOpts = {
    classify: throwOnlyClassify,
    longWaitMs: config.recoveryWaitMs,
    maxAttempts: config.recoveryMaxAttempts,
    sleep,
    onWait: ({ kind, waitMs, attempt }) =>
      console.error(`[prd2code] ${kind}: waiting ${Math.round(waitMs / 60000)}min before retry (attempt ${attempt}/${config.recoveryMaxAttempts})…`),
  };

  // --- adapters: each binds a tested module to the loop's dep contract ---

  const nextTask = () =>
    taskMasterNext({ runProcess, taskMasterBin: binaries.taskMaster, cwd, env });

  const setStatus = (id, status) =>
    taskMasterSetStatus({ runProcess, taskMasterBin: binaries.taskMaster, cwd, env }, id, status);

  const runWorkerTurn = ({ instruction, sessionId }) =>
    runWithRecovery(
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
          onEvent: reporter ? (ev) => reporter.workerEvent(ev) : undefined, // live stream
        }),
      recoveryOpts,
    );

  const snapshotStart = () => gtSnapshotStart({ runProcess, cwd });

  // Zero-config ground truth: an explicit config testCommand wins; otherwise
  // auto-detect from the repo each turn (it appears as the worker builds it).
  const collect = (snapshot) =>
    gtCollect({ runProcess, cwd, snapshot, testCommand: config.testCommand ?? detectTestCommand(cwd) });

  const buildDigest = ({ turn, groundTruth, task, turnIndex }) => {
    const { digest, json } = buildEvidenceDigest(
      { turn, groundTruth, task, turnIndex },
      { totalCap: config.digestMaxChars },
    );
    return { digest, json };
  };

  const decide = ({ instructions, evidenceJson }) =>
    runWithRecovery(
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
      recoveryOpts,
    ); // returns { decision, valid, reAsked }; throws recoveryExhausted only after N quota failures

  // Collect the bounded project map each turn so codex has cross-task awareness
  // (the single-task evidence digest can't give it). Cheap: git ls-files + tasks.json.
  const assemblePrompt = async ({ goal, memo: memoText }) => {
    let projectMap = '';
    try {
      projectMap = await collectProjectMap({ cwd, runProcess });
    } catch {
      /* a missing map must never block a turn */
    }
    return assembleCodexPrompt({ role, goal, memo: memoText, projectMap, memoCap: config.memoMaxChars });
  };

  const renderGoal = (task) => {
    const goal = renderTaskGoal(task, workerBootstrap);
    return runNote ? `${runNote}\n\n${goal}` : goal;
  };

  // Per-task stall tracking: reset the mechanical counter on each task's first turn.
  const preTurnGuard = ({ task, taskTurns }) => {
    if (taskTurns === 1) guard.reset();
    return guard.shouldEscalate() ? { escalate: true, question: guard.question(task.id) } : null;
  };
  const observeProgress = (groundTruth) => guard.observe(groundTruth);

  // Persist every turn to disk AND stream it to the console (if a reporter is wired).
  const logTurn = (t) => {
    log.logTurn(t);
    if (reporter) reporter.turn(t);
  };
  const onTaskStart = ({ task, taskIndex }) => {
    if (reporter) reporter.taskStart({ task, index: taskIndex, total: totalTasks });
  };

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
    logTurn,
    askHuman: askHumanFn,
    preTurnGuard,
    observeProgress,
    onTaskStart,
  };

  // --- Phase 3: whole-project acceptance helpers (codex deep-review + usage doc) ---
  const prdPath = path.join(cwd, '.taskmaster', 'docs', 'prd.md');
  const reviewProject = () =>
    runWithRecovery(async () => {
      let projectMap = '';
      try {
        projectMap = await collectProjectMap({ cwd, runProcess });
      } catch {
        /* map best-effort */
      }
      const prompt = buildAcceptancePrompt({
        role,
        prdPath,
        projectMap,
        testCommand: config.testCommand ?? detectTestCommand(cwd),
      });
      return runAcceptance({
        runProcess,
        codexBin: binaries.codex,
        schemaPath: ACCEPTANCE_SCHEMA_PATH,
        decisionFile: path.join(runDir, 'acceptance.json'),
        prompt,
        env,
        cwd,
        timeoutMs: config.timeouts.codexTurnMs,
      });
    }, recoveryOpts);

  const writeUsageDoc = () =>
    generateUsageDoc({ runProcess, claudeBin: binaries.claude, cwd, env, timeoutMs: config.timeouts.claudeTurnMs });

  return { deps, runDir, memoPath, reviewProject, writeUsageDoc, askHuman: askHumanFn };
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
 * Resolve config + sanitized env + binaries and assert subscription auth via the
 * startup probe. Throws a GUIDED login error (never an API-key fallback) if an
 * agent isn't reachable. Shared by build/resume and verify/docs. Returns
 * { config, env, binaries, probe }.
 */
export async function prepareRun({ cwd = process.cwd(), configOverride = null, baseEnv = process.env, runProcess = defaultRunProcess } = {}) {
  const config = validateConfig(configOverride ?? loadConfigFile(cwd));
  const env = sanitizeEnv(baseEnv);
  const binaries = await resolveAllBinaries(config, runProcess);
  const probe = await runStartupProbe({ runProcess, claudeBin: binaries.claude, codexBin: binaries.codex, env });
  if (!probe.claude.ok || !probe.codex.ok) {
    const err = new Error(buildLoginGuidance({ claudeOk: probe.claude.ok, codexOk: probe.codex.ok }));
    err.notLoggedIn = true;
    throw err;
  }
  // Provision the worker's per-repo permission boundary if the repo has none
  // (never clobber an existing one — the repo owns its rules).
  const settings = ensureWorkerSettings(cwd);
  if (settings.wrote) console.error(`[prd2code] wrote worker permissions to ${settings.path}`);
  return { config, env, binaries, probe };
}

/**
 * CLI entry. Resolves config + binaries, asserts subscription auth via the
 * startup probe, then drives the loop + acceptance. Throws (with login guidance)
 * if the probe fails — we never fall back to API-key auth.
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
  reporter,
  totalTasks = 0,
  runNote = '',
} = {}) {
  const { config, env, binaries } = await prepareRun({ cwd, configOverride, baseEnv, runProcess });

  const { deps, runDir, reviewProject, writeUsageDoc, askHuman: askHumanFn } = buildOrchestrator({
    config,
    binaries,
    schemaPath,
    cwd,
    env,
    runId,
    runProcess,
    logger,
    askHuman,
    reporter,
    totalTasks,
    runNote,
  });

  // Run the per-task loop, then whole-project acceptance (self-heal up to N rounds,
  // then escalate). reviewProject is codex's deep, firsthand review of the project.
  let result;
  try {
    result = await runWithAcceptance({
      runLoop: () => runLoop(deps),
      reviewProject,
      writeUsageDoc,
      askHuman: askHumanFn,
      appendFixTasks,
      cwd,
      maxRounds: config.acceptanceMaxRounds,
      log: (m) => console.error(`[prd2code] ${m}`),
    });
  } catch (err) {
    if (err.recoveryExhausted) {
      // Quota/network never recovered after N attempts — exit cleanly; the memo
      // and task state are on disk, so the user resumes later.
      console.error(`\n[prd2code] interrupted (${err.kind}) and could not recover: ${err.message}`);
      console.error(`[prd2code] progress is saved. Resume later with:  prd2code resume ${cwd}`);
    }
    throw err;
  }
  if (reporter) reporter.done(result);
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
