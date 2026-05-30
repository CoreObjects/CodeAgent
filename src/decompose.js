// decompose.js
// Turn a PRD into a task-master task list by driving `claude -p` DIRECTLY — the
// verified path on this host. (task-master's own claude-code provider hangs past
// 16 min via the agent-SDK.) The worker reads the PRD with the Read tool and
// emits a JSON array; assembleTasksJson wraps it into the tagged tasks.json.
//
// Model output is not guaranteed clean JSON, so we are defensive: tolerate prose
// and code fences around the array, and if it still won't parse, retry ONCE with
// a stricter "single line, escape newlines" prompt before giving up. On final
// failure the error carries claude's raw output (err.rawOutput) for diagnosis.
//
// Pure of side effects (no fs writes): the caller persists raw output / tasks.
// runProcess is injected for testing.

import { runProcess as defaultRunProcess } from './proc.js';
import { assembleTasksJson } from './task-gen.js';

function buildPrompt(prdPath, num, strict) {
  const base =
    `Read the file ${prdPath} in full using the Read tool. Break it into an ordered list of ` +
    `implementation tasks for task-master. Each element has EXACTLY: id (integer from 1, sequential), ` +
    `title, description (one sentence), details (2-5 sentences referencing the relevant REQ ids), ` +
    `testStrategy, priority (high|medium|low), dependencies (array of integer ids, [] if none), ` +
    `status (always "pending"), subtasks (always []). Produce ${num} tasks ordered so each appears ` +
    `after its dependencies.`;
  if (!strict) {
    return base + ` Output ONLY a raw JSON array — no markdown, no code fences, no commentary.`;
  }
  return (
    base +
    ` CRITICAL: output a SINGLE LINE of strictly valid, minified JSON. Escape EVERY newline inside a ` +
    `string value as \\n — never put a literal newline, tab, or unescaped double-quote inside a string. ` +
    `No markdown, no code fences, no prose. Output only the JSON array.`
  );
}

/** Pull the JSON array out of model text: drop fences/prose, keep first [ … last ]. */
export function extractTasksArrayText(text) {
  let t = String(text ?? '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) t = t.slice(start, end + 1);
  return t;
}

async function askClaudeForTasks(runProcess, claudeBin, prompt, env, timeoutMs) {
  const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read', '--permission-mode', 'acceptEdits'];
  const res = await runProcess(claudeBin, args, { env, timeoutMs });
  if (res.code !== 0 || res.error) {
    throw new Error(`PRD decomposition failed: ${res.error?.message ?? `claude exit ${res.code}`}${res.stderr ? `\n${res.stderr}` : ''}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    const e = new Error('PRD decomposition failed: claude did not return JSON output');
    e.rawOutput = res.stdout;
    throw e;
  }
  return envelope.result ?? '';
}

/**
 * @param {{prdPath:string, claudeBin:string, env:object, num?:string, timeoutMs?:number, runProcess?:Function, now?:string}} opts
 * @returns {Promise<{master:{tasks:any[], metadata:object}}>}
 */
export async function decomposePrd({ prdPath, claudeBin, env, num = '15 to 25', timeoutMs = 600_000, runProcess = defaultRunProcess, now }) {
  const meta = { description: `Tasks decomposed from ${prdPath}`, now: now ?? new Date().toISOString() };

  const first = await askClaudeForTasks(runProcess, claudeBin, buildPrompt(prdPath, num, false), env, timeoutMs);
  try {
    return assembleTasksJson(extractTasksArrayText(first), meta);
  } catch {
    // retry once, demanding strict single-line escaped JSON
    const second = await askClaudeForTasks(runProcess, claudeBin, buildPrompt(prdPath, num, true), env, timeoutMs);
    try {
      return assembleTasksJson(extractTasksArrayText(second), meta);
    } catch (e2) {
      const m = /position (\d+)/.exec(e2.message);
      const arr = extractTasksArrayText(second);
      const pos = m ? Number(m[1]) : 0;
      const near = arr.slice(Math.max(0, pos - 80), pos + 80);
      const err = new Error(`PRD decomposition: claude returned malformed task JSON after a strict retry (${e2.message}). Near: …${near}…`);
      err.rawOutput = second;
      throw err;
    }
  }
}
