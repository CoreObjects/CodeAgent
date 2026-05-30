// decompose.js
// Turn a PRD into a task-master task list by driving `claude -p` DIRECTLY — the
// verified path on this host. (task-master's own claude-code provider hangs past
// 16 min via the agent-SDK.) The worker reads the PRD with the Read tool and
// emits a raw JSON array; assembleTasksJson wraps it into the tagged tasks.json.
//
// Pure of side effects: it returns the tasks.json object; the caller writes it.
// runProcess is injected for testing.

import { runProcess as defaultRunProcess } from './proc.js';
import { assembleTasksJson } from './task-gen.js';

function buildPrompt(prdPath, num) {
  return (
    `Read the file ${prdPath} in full using the Read tool. Break it into an ordered list of ` +
    `implementation tasks for task-master. Output ONLY a raw JSON array — no markdown, no fences, ` +
    `no commentary. Each element has EXACTLY: id (integer from 1, sequential), title, description ` +
    `(one sentence), details (2-5 sentences referencing the relevant REQ ids), testStrategy, ` +
    `priority (high|medium|low), dependencies (array of integer ids, [] if none), status (always ` +
    `"pending"), subtasks (always []). Produce ${num} tasks ordered so each appears after its ` +
    `dependencies. Output the JSON array only.`
  );
}

/**
 * @param {{
 *   prdPath: string, claudeBin: string, env: object,
 *   num?: string, timeoutMs?: number,
 *   runProcess?: typeof defaultRunProcess, now?: string,
 * }} opts
 * @returns {Promise<{master:{tasks:any[], metadata:object}}>}
 */
export async function decomposePrd({
  prdPath,
  claudeBin,
  env,
  num = '15 to 25',
  timeoutMs = 600_000,
  runProcess = defaultRunProcess,
  now,
}) {
  const args = ['-p', buildPrompt(prdPath, num), '--output-format', 'json', '--allowedTools', 'Read', '--permission-mode', 'acceptEdits'];
  const res = await runProcess(claudeBin, args, { env, timeoutMs });
  if (res.code !== 0 || res.error) {
    throw new Error(`PRD decomposition failed: ${res.error?.message ?? `claude exit ${res.code}`}${res.stderr ? `\n${res.stderr}` : ''}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    throw new Error('PRD decomposition failed: claude did not return JSON output');
  }
  return assembleTasksJson(envelope.result, {
    description: `Tasks decomposed from ${prdPath}`,
    now: now ?? new Date().toISOString(),
  });
}
