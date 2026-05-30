// task-trunk.js — REQ-010
// Pass-through wrapper over the task-master trunk (next / show / set-status). It
// supplies WHAT task is on deck and records status; it NEVER decides whether a
// task is complete — that judgment is codex's, applied by the loop. All shell-outs
// route through proc.js (REQ-001).

import { runProcess as defaultRunProcess } from './proc.js';

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** `task-master next --format json` -> the on-deck task object, or null. */
export async function taskMasterNext({ runProcess = defaultRunProcess, taskMasterBin, cwd, env }) {
  const res = await runProcess(taskMasterBin, ['next', '--format', 'json'], { cwd, env });
  const obj = parseJson(res.stdout);
  return obj?.task ?? null;
}

/** `task-master show <id> --format json` -> the task object, or null. */
export async function taskMasterShow({ runProcess = defaultRunProcess, taskMasterBin, cwd, env }, id) {
  const res = await runProcess(taskMasterBin, ['show', String(id), '--format', 'json'], { cwd, env });
  const obj = parseJson(res.stdout);
  return obj?.task ?? obj ?? null;
}

/** `task-master set-status --id=<id> --status=<status>` -> { ok, code }. Called only by the loop. */
export async function taskMasterSetStatus({ runProcess = defaultRunProcess, taskMasterBin, cwd, env }, id, status) {
  const res = await runProcess(taskMasterBin, ['set-status', `--id=${id}`, `--status=${status}`], { cwd, env });
  return { ok: res.code === 0, code: res.code };
}
