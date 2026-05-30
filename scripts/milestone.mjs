// scripts/milestone.mjs — v1 closed-loop LIVE milestone runner (task 19)
//
// Scaffolds a throwaway git repo with three tiny seeded task-master tasks, then
// runs the REAL supervisor loop: codex (监工) drives a real Claude Code worker to
// implement them, marking each done only on codex's own task_complete verdict.
//
//   node scripts/milestone.mjs
//
// This SPENDS your shared subscription quota (claude Max + codex ChatGPT). It is
// never run by the test suite. The adversarial drills (false-done, escalation)
// are proven deterministically in test/main.test.js; this proves the live loop.
//
// Pitfall-aware: tasks are seeded directly (NOT via `task-master parse-prd`,
// which hangs on the claude-code provider on Windows). The orchestrator resolves
// the vendored codex/claude `.exe` itself and asserts subscription auth before
// running — refusing to start rather than ever touching an API key.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { runMain } from '../src/main.js';
import { runProcess } from '../src/proc.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SCRATCH = path.join(ROOT, '.milestone-scratch');

const TASKS = [
  {
    id: '1',
    title: 'sum',
    description: 'Add a sum(a, b) function to lib/math.js.',
    status: 'pending',
    priority: 'high',
    dependencies: [],
    details:
      'Create lib/math.js exporting `export function sum(a, b) { return a + b }`. Add test/math.test.js with a node:test case asserting sum(2,3)===5. Verify with `node --test`. Commit the change.',
    testStrategy: 'node --test passes with a sum assertion.',
    subtasks: [],
  },
  {
    id: '2',
    title: 'isEven',
    description: 'Add an isEven(n) function to lib/math.js.',
    status: 'pending',
    priority: 'high',
    dependencies: ['1'],
    details:
      'Add `export function isEven(n) { return n % 2 === 0 }` to lib/math.js. Extend test/math.test.js asserting isEven(4)===true and isEven(3)===false. Verify with `node --test`. Commit.',
    testStrategy: 'node --test passes with isEven assertions.',
    subtasks: [],
  },
  {
    id: '3',
    title: 'clamp',
    description: 'Add a clamp(x, lo, hi) function to lib/math.js.',
    status: 'pending',
    priority: 'medium',
    dependencies: ['1'],
    details:
      'Add `export function clamp(x, lo, hi)` bounding x to [lo, hi]. Extend test/math.test.js asserting clamp(5,0,3)===3 and clamp(-1,0,3)===0. Verify with `node --test`. Commit.',
    testStrategy: 'node --test passes with clamp assertions.',
    subtasks: [],
  },
];

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

async function git(args) {
  const res = await runProcess('git', args, { cwd: SCRATCH });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res;
}

async function scaffold() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });

  write(path.join(SCRATCH, 'package.json'), JSON.stringify({ name: 'mathlib', type: 'module', private: true }, null, 2));
  write(path.join(SCRATCH, 'lib', '.gitkeep'), '');
  write(path.join(SCRATCH, 'README.md'), '# mathlib (milestone scratch)\n');

  // Minimal task-master scaffold — next/show/set-status are non-AI, so model
  // config is irrelevant; tasks are seeded directly under the `master` tag.
  write(
    path.join(SCRATCH, '.taskmaster', 'config.json'),
    JSON.stringify(
      {
        models: {
          main: { provider: 'claude-code', modelId: 'sonnet' },
          research: { provider: 'claude-code', modelId: 'sonnet' },
          fallback: { provider: 'claude-code', modelId: 'sonnet' },
        },
        global: { defaultPriority: 'medium', projectName: 'mathlib-milestone' },
      },
      null,
      2,
    ),
  );
  write(
    path.join(SCRATCH, '.taskmaster', 'state.json'),
    JSON.stringify({ currentTag: 'master', branchTagMapping: {}, migrationNoticeShown: true }, null, 2),
  );
  write(
    path.join(SCRATCH, '.taskmaster', 'tasks', 'tasks.json'),
    JSON.stringify(
      { master: { tasks: TASKS, metadata: { created: '2026-05-29T00:00:00.000Z', description: 'v1 milestone scratch' } } },
      null,
      2,
    ),
  );

  await git(['init', '-q']);
  await git(['add', '-A']);
  await git(['-c', 'user.name=milestone', '-c', 'user.email=milestone@local', 'commit', '-q', '-m', 'scaffold mathlib milestone']);
}

function consoleAskHuman(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    process.stdout.write(`\n${'─'.repeat(60)}\n⛔ ESCALATION — your call:\n${question}\n${'─'.repeat(60)}\n> `);
    rl.question('', (a) => {
      rl.close();
      resolve(a.replace(/\r$/, ''));
    });
  });
}

async function main() {
  console.log('[milestone] scaffolding scratch repo at', SCRATCH);
  await scaffold();

  // Sanity-check the trunk before spending quota.
  const next = await runProcess('task-master', ['next', '--format', 'json'], { cwd: SCRATCH });
  if (next.code !== 0 || !next.stdout.trim()) {
    throw new Error(
      `task-master could not read the seeded scratch repo (code ${next.code}). ` +
        `Ensure task-master is installed and on PATH. stderr: ${next.stderr}`,
    );
  }
  console.log('[milestone] task-master sees the seeded tasks. Starting the supervisor loop…\n');

  const result = await runMain({
    cwd: SCRATCH,
    configOverride: {
      testCommand: ['node', '--test'],
      logDir: path.join(SCRATCH, 'runs'),
    },
    askHuman: consoleAskHuman,
  });

  console.log(`\n[milestone] DONE: ${result.reason} after ${result.turns} turns.`);
  console.log(`[milestone] Per-turn transcript: ${result.runDir}`);
  console.log('[milestone] Verify zero API usage on the Anthropic/OpenAI dashboards (REQ-012/REQ-019).');
}

main().catch((err) => {
  console.error(`[milestone] FAILED: ${err.message}`);
  process.exitCode = 1;
});
