// cli.js — the `superv` command: one shot, PRD in → built code repo out.
//
//   superv <prd> [out] [--out dir] [--num "20 to 26"] [--limit N]
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
import { resolveAllBinaries, sanitizeEnv, validateConfig } from './config.js';
import { decomposePrd } from './decompose.js';
import { ensureWorkerSettings } from './worker-permissions.js';
import { createConsoleReporter } from './reporter.js';
import { runMain } from './main.js';

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

/** Parse superv's argv (everything after the script name). */
export function parseSupervArgs(argv) {
  const out = { prd: null, out: null, num: '15 to 25', limit: 0, test: null, quiet: false, decompose: true };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet') out.quiet = true;
    else if (a === '--no-decompose') out.decompose = false;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--num') out.num = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0;
    else if (a === '--test') out.test = String(argv[++i]).trim().split(/\s+/).filter(Boolean);
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
  await g(['config', 'user.name', 'superv-worker']);
  await g(['config', 'user.email', 'superv@local']);
  await g(['add', '-A']);
  // a baseline commit so HEAD exists for the first ground-truth snapshot
  await g(['commit', '-q', '-m', 'superv: scaffold repo + PRD']);
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
    throw new Error('usage: superv <prd.md> [dir] [--out dir] [--num "20 to 26"] [--limit N] [--test "<cmd>"] [--quiet] [--no-decompose]');
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
  const env = { ...baseEnv, PYTHONUTF8: '1' };

  let total = 0;
  if (opts.decompose) {
    await scaffoldRepo({ outDir, prdPath, runProcess });

    const bins = await resolveAllBinaries(validateConfig({}), runProcess);
    console.error(`[superv] decomposing ${path.basename(prdPath)} → tasks (this calls claude once)…`);
    const tasksJson = await decomposePrd({
      prdPath: path.join(outDir, '.taskmaster', 'docs', 'prd.md'),
      claudeBin: bins.claude,
      env: sanitizeEnv(env),
      num: opts.num,
      runProcess,
    });
    if (opts.limit > 0) tasksJson.master.tasks = tasksJson.master.tasks.slice(0, opts.limit);
    const tp = path.join(outDir, '.taskmaster', 'tasks', 'tasks.json');
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, JSON.stringify(tasksJson, null, 2), 'utf8');
    total = tasksJson.master.tasks.length;
    console.error(`[superv] ${total} tasks. Building into ${outDir}\n`);
  } else {
    const tj = JSON.parse(fs.readFileSync(path.join(outDir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8'));
    total = tj.master?.tasks?.length ?? 0;
  }

  const rep = reporter ?? createConsoleReporter({ quiet: opts.quiet });
  const result = await runMain({
    cwd: outDir,
    baseEnv: env,
    configOverride: { testCommand: opts.test, logDir: path.join(outDir, 'runs') },
    reporter: rep,
    totalTasks: total,
    askHuman: askHuman ?? consoleAskHuman,
  });
  return { ...result, outDir, slug };
}
