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
import { runCodexSupervisor, assembleCodexPrompt } from './codex-supervisor.js';
import { createMemoStore } from './memo-store.js';
import { buildCodexSystemPrompt } from './codex-prompt.js';
import { buildWorkerBootstrap } from './worker-bootstrap.js';
import { createRunLogger, redactSecrets } from './logging.js';
import { createEscalationChannel } from './escalation.js';
import { createProgressGuard } from './progress-guard.js';
import { runWithRecovery, classifyResult } from './resilience.js';
import { ensureWorkerSettings } from './worker-permissions.js';
import { detectTestCommand } from './detect-test.js';
import { collectProjectMap } from './project-map.js';
import { buildAcceptancePrompt, buildCheckpointPrompt, runAcceptance, appendFixTasks, generateUsageDoc } from './acceptance.js';
import { classifyWorkerReport } from './worker-report.js';
import { runWithAcceptance } from './finalize.js';
import { buildLoginGuidance } from './onboarding.js';
import { runLoop } from './loop.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const DEFAULT_SCHEMA_PATH = path.join(PROJECT_ROOT, 'schema', 'codex-decision.schema.json');
const ACCEPTANCE_SCHEMA_PATH = path.join(PROJECT_ROOT, 'schema', 'acceptance.schema.json');

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
    classify: classifyResult, // detects a quota/session limit RETURNED by an agent, not just thrown
    longWaitMs: config.recoveryWaitMs,
    maxAttempts: config.recoveryMaxAttempts,
    bufferMs: config.recoveryBufferMs, // wait until the parsed reset time + this buffer
    sleep,
    onWait: ({ kind, waitMs, attempt }) =>
      console.error(`[prd2code] ${kind}: waiting ${Math.round(waitMs / 60000)}min before retry (attempt ${attempt}/${config.recoveryMaxAttempts})…`),
  };

  // --- adapters: each binds a tested module to the loop's dep contract ---

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
          model: config.claudeModel,
          effort: config.claudeEffort,
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
    gtCollect({
      runProcess,
      cwd,
      snapshot,
      testCommand: config.testCommand ?? detectTestCommand(cwd),
      testTimeoutMs: config.timeouts.testMs, // never let a hung (e.g. GUI) test block forever
      env,
    });

  const observeProgress = (groundTruth) => guard.observe(groundTruth);
  // Mechanical stall guard (free, no LLM): surfaces a spin to the human.
  const stallGuard = () => (guard.shouldEscalate() ? { escalate: true, question: guard.question('the current phase') } : null);

  const projectMapNow = async () => {
    try {
      return await collectProjectMap({ cwd, runProcess });
    } catch {
      return '';
    }
  };
  const checkpointPrdPath = path.join(cwd, '.taskmaster', 'docs', 'prd.md');
  const testCmd = () => config.testCommand ?? detectTestCommand(cwd);

  // codex = checkpoint EXAMINER: at a reported checkpoint, read the PRD criteria +
  // the code + run the tests, judge real-vs-faked functionality. Reuses runAcceptance.
  const verifyCheckpoint = async ({ checkpoint }) => {
    const projectMap = await projectMapNow();
    const prompt =
      buildCheckpointPrompt({ role, prdPath: checkpointPrdPath, projectMap, testCommand: testCmd(), checkpoint }) +
      (memo.read() ? `\n\n### YOUR PRIOR CHECKPOINT NOTES\n${memo.read()}` : '');
    const r = await runWithRecovery(
      () =>
        runAcceptance({
          runProcess,
          codexBin: binaries.codex,
          schemaPath: ACCEPTANCE_SCHEMA_PATH,
          decisionFile: path.join(runDir, 'checkpoint.json'),
          prompt,
          env,
          cwd,
          timeoutMs: config.timeouts.codexTurnMs,
        }),
      recoveryOpts,
    );
    return r.decision;
  };

  // codex answers/escalates a worker BLOCK (rare). Reuses runCodexSupervisor.
  const decideBlock = async ({ question, groundTruth }) => {
    const projectMap = await projectMapNow();
    const blockRole = `${role}\n\nThe worker is BLOCKED and needs a decision. ANSWER it yourself (verdict=redirect, put the answer/decision in message_to_claude) when it is within your authority; ESCALATE (verdict=escalate) only if it hits the whitelist (irreversible / money / security_privacy_legal / scope_product / judgment_human_would_want).`;
    const instructions = assembleCodexPrompt({ role: blockRole, goal: `BLOCKED: ${question}`, memo: memo.read(), projectMap, memoCap: config.memoMaxChars });
    const r = await runWithRecovery(
      () =>
        runCodexSupervisor({
          runProcess,
          codexBin: binaries.codex,
          schemaPath,
          decisionFile: decisionPath,
          instructions,
          evidenceJson: JSON.stringify({ blocked_question: question, ground_truth: groundTruth }),
          env,
          cwd,
          timeoutMs: config.timeouts.codexTurnMs,
        }),
      recoveryOpts,
    );
    const d = r.decision;
    if (d.verdict === 'escalate') return { kind: 'escalate', question: d.escalation_question };
    if (d.verdict === 'abort') return { kind: 'abort' };
    return { kind: 'redirect', message: d.message_to_claude || d.assessment || 'Proceed.' };
  };

  const beginInstruction =
    `${runNote ? runNote + '\n\n' : ''}${workerBootstrap}\n\n` +
    'Begin now: read the PRD and the task-master tasks, then start with the first phase and work toward its checkpoint.';

  const logTurn = (t) => {
    log.logTurn(t);
    const changed = t.groundTruth?.changedFiles?.length ?? 0;
    const test = t.groundTruth?.test ? `, test exit ${t.groundTruth.test.exitCode}` : '';
    console.error(`    facts: ${changed} file(s) changed${test} · worker: ${t.report?.status ?? '?'}`);
  };
  const onCheckpoint = ({ checkpoint, decision }) => {
    console.error(`[prd2code] checkpoint "${checkpoint}": ${decision.accept ? 'PASSED ✓' : 'REJECTED ✗ — ' + String(decision.report ?? '').slice(0, 200)}`);
    if (reporter && reporter.checkpoint) reporter.checkpoint({ checkpoint, decision });
  };

  const deps = {
    runWorkerTurn,
    classifyReport: classifyWorkerReport,
    snapshotStart,
    collect,
    observeProgress,
    stallGuard,
    verifyCheckpoint,
    decideBlock,
    memo,
    askHuman: askHumanFn,
    logTurn,
    onCheckpoint,
    beginInstruction,
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
