#!/usr/bin/env node
// scripts/generate-tasks.mjs — REQ-019 (subtask 4.3)
// The VERIFIED task-generation path, captured as one callable script.
//
// task-master's claude-code provider hangs on this host (agent-SDK never spawns
// a worker, >16 min). The verified path drives the `claude` CLI directly:
//   1. claude -p reads the PRD and emits a JSON array of tasks
//   2. assembleTasksJson() wraps it in task-master's tagged tasks.json
//   3. task-master list validates that the result parses
//
// Usage:
//   node scripts/generate-tasks.mjs [--prd <path>] [--out <path>] [--num <n>]
//
// Env: PYTHONUTF8=1 is set for any task-master helper that reads UTF-8 under the
// GBK host locale. NEVER pass --bare to claude (that forces API-key auth).

import fs from 'node:fs';
import process from 'node:process';
import { runProcess } from '../src/proc.js';
import { resolveAllBinaries, sanitizeEnv, validateConfig } from '../src/config.js';
import { assembleTasksJson } from '../src/task-gen.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const prdPath = arg('prd', '.taskmaster/docs/prd.md');
const outPath = arg('out', '.taskmaster/tasks/tasks.json');
const num = arg('num', '18 to 24');

const PROMPT =
  `Read the file ${prdPath} in full using the Read tool. Break it into an ordered list of ` +
  `implementation tasks for task-master. Output ONLY a raw JSON array — no markdown, no code ` +
  `fences, no commentary. Each element has EXACTLY: id (integer from 1, sequential), title, ` +
  `description (one sentence), details (2-5 sentences referencing the relevant REQ ids), ` +
  `testStrategy, priority (high|medium|low), dependencies (array of integer ids, [] if none), ` +
  `status (always "pending"), subtasks (always []). Produce ${num} tasks ordered so each task ` +
  `appears after its dependencies. Output the JSON array only.`;

const env = { ...sanitizeEnv(), PYTHONUTF8: '1' };
const bins = await resolveAllBinaries(validateConfig({}), runProcess);

console.error(`[generate-tasks] driving ${bins.claude} on ${prdPath} ...`);
const res = await runProcess(
  bins.claude,
  ['-p', PROMPT, '--output-format', 'json', '--allowedTools', 'Read', '--permission-mode', 'acceptEdits'],
  { env, timeoutMs: 600_000 },
);
if (res.code !== 0 || res.error) {
  console.error('[generate-tasks] claude failed:', res.error ?? `exit ${res.code}`);
  process.exit(1);
}

const envelope = JSON.parse(res.stdout);
const tasksJson = assembleTasksJson(envelope.result, {
  description: 'Tasks generated from ' + prdPath,
  now: new Date().toISOString(),
});
fs.writeFileSync(outPath, JSON.stringify(tasksJson, null, 2), 'utf8');
console.error(`[generate-tasks] wrote ${tasksJson.master.tasks.length} tasks to ${outPath}`);

// Validate that task-master can parse what we wrote.
const list = await runProcess(bins.taskMaster, ['list'], { env });
process.exit(list.code === 0 ? 0 : 1);
