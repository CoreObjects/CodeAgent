// preflight.js — REQ-019
// Environment preflight: confirm the real Python interpreter, resolve binaries,
// run the subscription auth probe, and carry the verified-pitfalls record that
// REQ-014 inlines into the codex system prompt so the worker is steered to the
// verified path from the first turn instead of rediscovering pitfalls.

import { runProcess as defaultRunProcess } from './proc.js';
import {
  validateConfig,
  resolveAllBinaries,
  runStartupProbe,
  sanitizeEnv,
} from './config.js';

// --- 4.1 Python interpreter detection ------------------------------------

function pythonVersion(result) {
  if (!result || result.code !== 0) return null;
  const m = `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/Python\s+([\d.]+)/i);
  return m ? m[1] : null;
}

/** The `python3` Microsoft Store stub exits 49 with no output. */
export function isPython3Stub(result) {
  if (!result) return false;
  if (result.code === 49) return true;
  return result.error == null && result.code !== 0 && !pythonVersion(result);
}

/** Choose the real interpreter; `python3` on this host is the Store stub. */
export function pickPython(pyResult, py3Result) {
  const pyVer = pythonVersion(pyResult);
  if (pyVer) return { command: 'python', version: pyVer };
  const py3Ver = pythonVersion(py3Result);
  if (py3Ver && !isPython3Stub(py3Result)) return { command: 'python3', version: py3Ver };
  const stubNote = isPython3Stub(py3Result)
    ? ' and `python3` is the Microsoft Store stub (exit 49)'
    : '';
  throw new Error(`No usable Python interpreter: \`python\` reported no version${stubNote}`);
}

/** Resolve the real interpreter and the env (PYTHONUTF8=1) for UTF-8 scripts under the GBK locale. */
export async function resolvePython(runProcess = defaultRunProcess) {
  const [py, py3] = await Promise.all([
    runProcess('python', ['--version']),
    runProcess('python3', ['--version']),
  ]);
  const picked = pickPython(py, py3);
  return { ...picked, env: { PYTHONUTF8: '1' } };
}

// --- 4.4 Structured pitfalls record (persisted; inlined into codex prompt) ---

export const PITFALLS = [
  {
    id: 'python3-stub',
    problem: '`python3` is the Microsoft Store stub (exit 49, no output)',
    workaround: 'use `python` (real CPython 3.10.7)',
  },
  {
    id: 'gbk-locale',
    problem: 'host locale is GBK; Python decodes UTF-8 files as GBK and crashes',
    workaround: 'set PYTHONUTF8=1 for any UTF-8-reading script',
  },
  {
    id: 'taskmaster-hyphen',
    problem: 'the CLI is `task-master` (hyphenated); a `taskmaster` lookup does not resolve',
    workaround: 'invoke `task-master`',
  },
  {
    id: 'cmd-vs-exe',
    problem: 'driving codex/claude via the `.cmd` node shim is slow (~98s) and triggers a model-refresh timeout',
    workaround: 'resolve and run the vendored native `.exe`',
  },
  {
    id: 'codex-stdin-eof',
    problem: '`codex exec` blocks reading stdin until EOF',
    workaround: 'pipe the evidence digest to codex stdin, or close stdin',
  },
  {
    id: 'agent-sdk-provider-hangs',
    problem: 'task-master `claude-code` provider hangs (agent-SDK never spawns a worker, >16 min)',
    workaround: 'drive the `claude` CLI directly to generate tasks',
  },
];

/** Render the pitfalls as one line each for inlining into the codex system prompt. */
export function formatPitfallsForPrompt(record = PITFALLS) {
  return record.map((p) => `- ${p.problem} -> ${p.workaround}`).join('\n');
}

// --- 4.2 Wired preflight --------------------------------------------------

/**
 * Run the full preflight: Python, binary resolution, and the subscription auth
 * probe (claude -p + codex exec). Returns a structured result; `ok` is true only
 * when both agents round-trip under subscription.
 */
export async function runPreflight({ runProcess = defaultRunProcess, config = validateConfig({}) } = {}) {
  const python = await resolvePython(runProcess);
  const binaries = await resolveAllBinaries(config, runProcess);
  const probe = await runStartupProbe({
    runProcess,
    claudeBin: binaries.claude,
    codexBin: binaries.codex,
    env: sanitizeEnv(),
  });
  return {
    python,
    binaries,
    probe,
    pitfalls: PITFALLS,
    ok: probe.claude.ok && probe.codex.ok,
  };
}
