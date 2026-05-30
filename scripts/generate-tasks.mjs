#!/usr/bin/env node
// scripts/generate-tasks.mjs — standalone PRD→tasks utility.
// Thin wrapper over src/decompose.js (the reusable, tested decomposition). Drives
// `claude -p` directly — NOT task-master's claude-code provider, which hangs on
// this host. NEVER passes --bare (that would force API-key auth).
//
//   node scripts/generate-tasks.mjs [--prd <path>] [--out <path>] [--num <range>]

import fs from 'node:fs';
import process from 'node:process';
import { runProcess } from '../src/proc.js';
import { resolveAllBinaries, sanitizeEnv, validateConfig } from '../src/config.js';
import { decomposePrd } from '../src/decompose.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const prdPath = arg('prd', '.taskmaster/docs/prd.md');
const outPath = arg('out', '.taskmaster/tasks/tasks.json');
const num = arg('num', '18 to 24');

const env = { ...sanitizeEnv(), PYTHONUTF8: '1' };
const bins = await resolveAllBinaries(validateConfig({}), runProcess);

console.error(`[generate-tasks] driving ${bins.claude} on ${prdPath} ...`);
const tasksJson = await decomposePrd({ prdPath, claudeBin: bins.claude, env, num, runProcess });
fs.writeFileSync(outPath, JSON.stringify(tasksJson, null, 2), 'utf8');
console.error(`[generate-tasks] wrote ${tasksJson.master.tasks.length} tasks to ${outPath}`);

// Validate that task-master can parse what we wrote.
const list = await runProcess(bins.taskMaster, ['list'], { env });
process.exit(list.code === 0 ? 0 : 1);
