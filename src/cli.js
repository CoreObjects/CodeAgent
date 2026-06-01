// cli.js — the `prd2code` command: one shot, PRD in → built code repo out.
//
//   prd2code <prd> [out] [--out dir] [--num "20 to 26"] [--limit N]
//          [--test "<cmd>"] [--quiet] [--no-decompose]
//
// Zero config: no config file, no test command, no CLAUDE.md required. It
// scaffolds a fresh repo named after the PRD, decomposes the PRD into tasks
// (driving `claude -p` directly), then runs the supervisor loop with a live
// console reporter until the repo is built — pausing only for codex escalations.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { runProcess as defaultRunProcess } from './proc.js';
import { resolveAllBinaries, sanitizeEnv, validateConfig, HEADLESS_ENV } from './config.js';
import { decomposePrd } from './decompose.js';
import { ensureWorkerSettings } from './worker-permissions.js';
import { createConsoleReporter } from './reporter.js';
import { runMain, prepareRun, buildOrchestrator } from './main.js';
import { generateUsageDoc } from './acceptance.js';
import { runPreflight } from './preflight.js';
import { buildLoginGuidance } from './onboarding.js';

// --- pure helpers (unit-tested) ------------------------------------------

export function slugify(s) {
  const slug = String(s)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '') // drop punctuation and non-ASCII (CJK etc.)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug;
}

/** Derive a repo slug from the PRD's H1 title (fallback: the file's base name). */
export function slugFromPrd(prdText, fallbackName = 'project') {
  const m = String(prdText).match(/^#\s+(.+)$/m);
  let title = m ? m[1] : fallbackName;
  title = title.replace(/^\s*PRD\s*[:\-—–]\s*/i, ''); // strip a leading "PRD:" label
  title = title.split(/[—–:(（]/)[0]; // keep the name before the first separator
  return slugify(title) || slugify(fallbackName) || 'project';
}

/** Parse the command's argv (everything after the script name). */
export function parseSupervArgs(argv) {
  const out = { prd: null, out: null, num: '15 to 25', limit: 0, test: null, quiet: false, decompose: true, model: null, effort: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet') out.quiet = true;
    else if (a === '--no-decompose') out.decompose = false;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--num') out.num = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--test') out.test = String(argv[++i]).trim().split(/\s+/).filter(Boolean);
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--effort') out.effort = argv[++i];
    else if (!a.startsWith('--')) positionals.push(a);
  }
  out.prd = positionals[0] ?? null;
  if (out.out == null && positionals[1]) out.out = positionals[1];
  return out;
}

// --- orchestration (covered by the live smoke) ---------------------------

function writeScaffold(dir) {
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('.taskmaster/config.json', JSON.stringify({
    models: { main: { provider: 'claude-code', modelId: 'sonnet' }, research: { provider: 'claude-code', modelId: 'sonnet' }, fallback: { provider: 'claude-code', modelId: 'sonnet' } },
    global: { defaultPriority: 'medium' },
  }, null, 2));
  w('.taskmaster/state.json', JSON.stringify({ currentTag: 'master', branchTagMapping: {}, migrationNoticeShown: true }, null, 2));
}

async function gitInitWithBaseline(dir, runProcess) {
  const g = (args) => runProcess('git', args, { cwd: dir });
  await g(['init', '-q']);
  await g(['config', 'user.name', 'prd2code-worker']);
  await g(['config', 'user.email', 'prd2code@local']);
  await g(['add', '-A']);
  // a baseline commit so HEAD exists for the first ground-truth snapshot
  await g(['commit', '-q', '-m', 'prd2code: scaffold repo + PRD']);
}

/**
 * Lay down a fresh target repo: task-master scaffold, the PRD, the worker
 * permission boundary, and a git baseline commit. Exported for regression tests.
 */
export async function scaffoldRepo({ outDir, prdPath, runProcess = defaultRunProcess }) {
  writeScaffold(outDir);
  const docsDir = path.join(outDir, '.taskmaster', 'docs');
  fs.mkdirSync(docsDir, { recursive: true }); // copyFileSync does NOT create the dir
  fs.copyFileSync(prdPath, path.join(docsDir, 'prd.md'));
  ensureWorkerSettings(outDir, { overwrite: true });
  // Keep orchestrator state (codex memo, per-run transcripts) out of the worker's commits.
  const gi = path.join(outDir, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!/^\.prd2code\/$/m.test(existing)) {
    fs.writeFileSync(gi, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}# prd2code orchestrator state\n.prd2code/\nruns/\n`, 'utf8');
  }
  await gitInitWithBaseline(outDir, runProcess);
}

function consoleAskHuman(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    process.stdout.write(`\n${'─'.repeat(56)}\n⛔ codex needs your call:\n${question}\n${'─'.repeat(56)}\n> `);
    rl.question('', (a) => {
      rl.close();
      resolve(a.replace(/\r$/, ''));
    });
  });
}

/**
 * Run the whole chain. Returns { ...loopResult, outDir, slug }.
 */
export async function runSuperv({
  argv,
  cwd = process.cwd(),
  runProcess = defaultRunProcess,
  baseEnv = process.env,
  reporter,
  askHuman,
} = {}) {
  const opts = parseSupervArgs(argv);
  if (!opts.prd) {
    throw new Error('usage: prd2code <prd.md> [dir] [--out dir] [--num "20 to 26"] [--limit N] [--test "<cmd>"] [--model sonnet] [--effort high] [--quiet] [--no-decompose]');
  }

  const prdPath = path.resolve(cwd, opts.prd);
  if (!fs.existsSync(prdPath)) throw new Error(`PRD not found: ${prdPath}`);
  const prdText = fs.readFileSync(prdPath, 'utf8');
  const slug = slugFromPrd(prdText, path.basename(prdPath, path.extname(prdPath)));
  const outDir = path.resolve(cwd, opts.out ?? slug);

  const fresh = !fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0;
  if (!fresh && opts.decompose) {
    throw new Error(`target ${outDir} is not empty — pick another dir, or pass --no-decompose to continue an existing run`);
  }

  // env: keep UTF-8 sane for Python toolchains under a GBK locale.
  const env = { ...baseEnv, PYTHONUTF8: '1', ...HEADLESS_ENV };

  let total = 0;
  if (opts.decompose) {
    await scaffoldRepo({ outDir, prdPath, runProcess });

    const bins = await resolveAllBinaries(validateConfig({}), runProcess);
    console.error(`[prd2code] decomposing ${path.basename(prdPath)} → tasks (this calls claude)…`);
    let tasksJson;
    try {
      tasksJson = await decomposePrd({
        prdPath: path.join(outDir, '.taskmaster', 'docs', 'prd.md'),
        claudeBin: bins.claude,
        env: sanitizeEnv(env),
        num: opts.num,
        runProcess,
        model: opts.model || 'sonnet',
        effort: opts.effort || 'high',
      });
    } catch (err) {
      // Persist claude's raw output for diagnosis, and clean up the freshly
      // scaffolded dir so the next run isn't blocked by the non-empty guard.
      if (err.rawOutput) {
        const dbg = path.join(cwd, 'prd2code-decompose-raw.txt');
        try {
          fs.writeFileSync(dbg, err.rawOutput, 'utf8');
          err.message += `\n[prd2code] saved claude's raw output to ${dbg}`;
        } catch {
          /* best effort */
        }
      }
      if (fresh) fs.rmSync(outDir, { recursive: true, force: true });
      throw err;
    }
    if (opts.limit > 0) tasksJson.master.tasks = tasksJson.master.tasks.slice(0, opts.limit);
    const tp = path.join(outDir, '.taskmaster', 'tasks', 'tasks.json');
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, JSON.stringify(tasksJson, null, 2), 'utf8');
    total = tasksJson.master.tasks.length;
    console.error(`[prd2code] ${total} tasks. Building into ${outDir}\n`);
  } else {
    const tj = JSON.parse(fs.readFileSync(path.join(outDir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8'));
    total = tj.master?.tasks?.length ?? 0;
  }

  const rep = reporter ?? createConsoleReporter({ quiet: opts.quiet });
  const configOverride = { testCommand: opts.test, logDir: path.join(outDir, 'runs') };
  if (opts.model) configOverride.claudeModel = opts.model;
  if (opts.effort) configOverride.claudeEffort = opts.effort;
  const result = await runMain({
    cwd: outDir,
    baseEnv: env,
    configOverride,
    reporter: rep,
    totalTasks: total,
    askHuman: askHuman ?? consoleAskHuman,
  });
  return { ...result, outDir, slug };
}

// --- subcommand dispatch -------------------------------------------------

const SUBCOMMANDS = new Set(['resume', 'verify', 'docs', 'status', 'doctor', 'report', 'clean', 'login']);

/** Route argv to a subcommand, defaulting to `build` (a bare PRD path). Pure. */
export function parseCommand(argv) {
  const first = argv[0];
  if (SUBCOMMANDS.has(first)) return { command: first, rest: argv.slice(1) };
  return { command: 'build', rest: argv };
}

function readTasks(tasksPath) {
  try {
    return JSON.parse(fs.readFileSync(tasksPath, 'utf8')).master?.tasks ?? [];
  } catch {
    return [];
  }
}

/** One-line progress summary from a task list. Pure. */
export function formatStatus(tasks) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const current = tasks.find((t) => t.status !== 'done');
  const head = `Progress: ${done}/${total} tasks done`;
  return current ? `${head}; next: #${current.id} ${current.title ?? ''}`.trimEnd() : `${head} — all complete`;
}

function projectDir(argv, cwd) {
  return path.resolve(cwd, argv[0] ?? '.');
}
function assertProject(dir) {
  if (!fs.existsSync(path.join(dir, '.taskmaster'))) throw new Error(`not a prd2code project (no .taskmaster/): ${dir}`);
}

/**
 * Resume an interrupted build in <dir>. The PRD was copied in at build time, so
 * only the dir is needed. If decomposition never finished, finish it first. The
 * codex memo (stable path) and task state are reloaded; codex/claude are told
 * they are resuming so they survey the existing code before continuing.
 */
export async function runResume({ argv = [], cwd = process.cwd(), runProcess = defaultRunProcess, baseEnv = process.env, reporter, askHuman } = {}) {
  const opts = parseSupervArgs(argv); // reuse flag parsing; positional[0] is the dir
  const dir = path.resolve(cwd, opts.prd ?? '.');
  if (!fs.existsSync(path.join(dir, '.taskmaster'))) throw new Error(`not a prd2code project (no .taskmaster/): ${dir}`);
  const prdInRepo = path.join(dir, '.taskmaster', 'docs', 'prd.md');
  if (!fs.existsSync(prdInRepo)) throw new Error(`no PRD at ${prdInRepo} — cannot resume`);

  process.env.PYTHONUTF8 = '1';
  const env = { ...baseEnv, PYTHONUTF8: '1', ...HEADLESS_ENV };

  const tasksPath = path.join(dir, '.taskmaster', 'tasks', 'tasks.json');
  let tasks = readTasks(tasksPath);
  if (!tasks.length) {
    const bins = await resolveAllBinaries(validateConfig({}), runProcess);
    console.error('[prd2code] no tasks yet — finishing decomposition before resuming…');
    const tj = await decomposePrd({ prdPath: prdInRepo, claudeBin: bins.claude, env: sanitizeEnv(env), runProcess, model: opts.model || 'sonnet', effort: opts.effort || 'high' });
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
    fs.writeFileSync(tasksPath, JSON.stringify(tj, null, 2), 'utf8');
    tasks = tj.master.tasks;
  }
  const total = tasks.length;
  const doneN = tasks.filter((t) => t.status === 'done').length;
  console.error(`[prd2code] resuming ${dir} — ${doneN}/${total} tasks done.\n`);

  const configOverride = { logDir: path.join(dir, 'runs') };
  if (opts.model) configOverride.claudeModel = opts.model;
  if (opts.effort) configOverride.claudeEffort = opts.effort;
  const result = await runMain({
    cwd: dir,
    baseEnv: env,
    configOverride,
    reporter: reporter ?? createConsoleReporter({}),
    askHuman: askHuman ?? consoleAskHuman,
    totalTasks: total,
    runNote:
      'You are RESUMING an interrupted build. The repo already contains prior work — read the existing code and current task state before changing anything, and continue from where it left off.',
  });
  return { ...result, outDir: dir };
}

/** status <dir> — read tasks.json, print progress. No quota. */
export async function runStatus({ argv = [], cwd = process.cwd() } = {}) {
  const dir = projectDir(argv, cwd);
  const tasks = readTasks(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'));
  console.error(`[prd2code] ${dir}`);
  console.error(tasks.length ? formatStatus(tasks) : 'no tasks yet (decomposition not finished)');
  return { reason: 'status' };
}

/** doctor — preflight: python, binaries, subscription auth. No tasks run. */
export async function runDoctor({ runProcess = defaultRunProcess } = {}) {
  console.error('[prd2code] doctor:');
  try {
    const pre = await runPreflight({ runProcess });
    console.error(`  python : ${pre.python?.command ?? '?'} ${pre.python?.version ?? ''}`);
    console.error(`  claude : ${pre.probe.claude.ok ? 'OK (subscription)' : 'NOT logged in'}  ${pre.binaries?.claude ?? ''}`);
    console.error(`  codex  : ${pre.probe.codex.ok ? 'OK (subscription)' : 'NOT logged in'}  ${pre.binaries?.codex ?? ''}`);
    if (pre.ok) console.error('  ✓ ready');
    else console.error('\n' + buildLoginGuidance({ claudeOk: pre.probe.claude.ok, codexOk: pre.probe.codex.ok }));
    return { reason: 'doctor', ok: pre.ok };
  } catch (err) {
    console.error(`  preflight failed: ${err.message}`);
    return { reason: 'doctor', ok: false };
  }
}

/** login — show auth status and the exact (subscription, no-API-key) login steps. */
export async function runLogin({ runProcess = defaultRunProcess } = {}) {
  const pre = await runPreflight({ runProcess }).catch(() => null);
  const claudeOk = pre?.probe?.claude?.ok ?? false;
  const codexOk = pre?.probe?.codex?.ok ?? false;
  if (claudeOk && codexOk) {
    console.error('[prd2code] already signed in (claude + codex, subscription). You are ready.');
    return { reason: 'login', ok: true };
  }
  console.error(buildLoginGuidance({ claudeOk, codexOk }));
  return { reason: 'login', ok: false };
}

/** clean <dir> — remove orchestrator state (.prd2code/, runs/) so a run can restart clean. */
export async function runClean({ argv = [], cwd = process.cwd() } = {}) {
  const dir = projectDir(argv, cwd);
  const removed = [];
  for (const sub of ['.prd2code', 'runs']) {
    const p = path.join(dir, sub);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(sub);
    }
  }
  console.error(`[prd2code] cleaned ${removed.length ? removed.join(', ') : 'nothing'} in ${dir}`);
  return { reason: 'clean' };
}

/** verify <dir> — codex deep-reviews the whole project and prints the report. */
export async function runVerify({ argv = [], cwd = process.cwd(), runProcess = defaultRunProcess, baseEnv = process.env, askHuman } = {}) {
  const dir = projectDir(argv, cwd);
  assertProject(dir);
  process.env.PYTHONUTF8 = '1';
  const { config, env, binaries } = await prepareRun({ cwd: dir, configOverride: { logDir: path.join(dir, 'runs') }, baseEnv: { ...baseEnv, PYTHONUTF8: '1', ...HEADLESS_ENV }, runProcess });
  const { reviewProject } = buildOrchestrator({ config, binaries, cwd: dir, env, runId: 'verify', runProcess, askHuman });
  console.error('[prd2code] running whole-project acceptance review…');
  const { decision } = await reviewProject();
  console.error(`\n[prd2code] acceptance: ${decision.accept ? 'ACCEPTED ✓' : 'REJECTED ✗'}`);
  if (decision.report) console.error(decision.report);
  return { reason: 'verify', accept: decision.accept };
}

/** docs <dir> — (re)generate the usage README from the PRD + code. */
export async function runDocs({ argv = [], cwd = process.cwd(), runProcess = defaultRunProcess, baseEnv = process.env } = {}) {
  const dir = projectDir(argv, cwd);
  assertProject(dir);
  process.env.PYTHONUTF8 = '1';
  const { binaries, env } = await prepareRun({ cwd: dir, baseEnv: { ...baseEnv, PYTHONUTF8: '1', ...HEADLESS_ENV }, runProcess });
  console.error('[prd2code] writing usage doc (README)…');
  const r = await generateUsageDoc({ runProcess, claudeBin: binaries.claude, cwd: dir, env });
  console.error(r.ok ? '[prd2code] README written.' : '[prd2code] usage-doc generation failed.');
  return { reason: 'docs', ok: r.ok };
}

/** report <dir> — print the latest run's transcript tail + acceptance result. */
export async function runReport({ argv = [], cwd = process.cwd() } = {}) {
  const dir = projectDir(argv, cwd);
  const runsDir = path.join(dir, 'runs');
  let runDirs = [];
  try {
    runDirs = fs.readdirSync(runsDir).map((n) => path.join(runsDir, n)).filter((p) => fs.statSync(p).isDirectory());
  } catch {
    /* none */
  }
  if (!runDirs.length) {
    console.error(`[prd2code] no runs found in ${runsDir}`);
    return { reason: 'report' };
  }
  const latest = runDirs.sort()[runDirs.length - 1];
  const transcript = path.join(latest, 'transcript.md');
  if (fs.existsSync(transcript)) {
    console.error(`[prd2code] ${transcript} (tail):\n`);
    console.error(fs.readFileSync(transcript, 'utf8').slice(-4000));
  }
  const accept = path.join(latest, 'acceptance.json');
  if (fs.existsSync(accept)) {
    try {
      const a = JSON.parse(fs.readFileSync(accept, 'utf8'));
      console.error(`\n[prd2code] acceptance: ${a.accept ? 'ACCEPTED' : 'REJECTED'}\n${a.report ?? ''}`);
    } catch {
      /* ignore */
    }
  }
  return { reason: 'report' };
}

/** Top-level CLI dispatch: `prd2code <subcommand|prd>`. */
export async function runCli({ argv = [], ...rest } = {}) {
  const { command, rest: cmdArgs } = parseCommand(argv);
  const handlers = { resume: runResume, verify: runVerify, docs: runDocs, status: runStatus, doctor: runDoctor, report: runReport, clean: runClean, login: runLogin };
  if (handlers[command]) return handlers[command]({ argv: cmdArgs, ...rest });
  return runSuperv({ argv: cmdArgs, ...rest });
}
