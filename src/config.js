// config.js — REQ-012
// Config schema/loader, binary path resolution, env sanitization (subscription
// enforced at the process boundary), and the startup auth probe.
//
// Path resolution and the probe shell out, but ALWAYS through proc.js
// (runProcess) — config.js never touches node:child_process directly.

import { runProcess as defaultRunProcess } from './proc.js';

export const DEFAULT_CONFIG = {
  // Absolute-path overrides for the three CLIs; null => resolve via where/which.
  binaries: { claude: null, codex: null, taskMaster: null },
  timeouts: { processMs: 120_000, claudeTurnMs: 1_800_000, codexTurnMs: 600_000 },
  memoMaxChars: 6000,
  digestMaxChars: 6000,
  testCommand: null,
  logDir: 'runs',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite'],
};

const API_KEY_NAMED = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

/**
 * Return a copy of `env` with every API-key variable removed so child processes
 * fall back to subscription auth. Strips the two named keys plus any *_API_KEY.
 * Non-key variables (PATH, PYTHONUTF8, ...) are preserved. Input is not mutated.
 */
export function sanitizeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (API_KEY_NAMED.has(upper) || upper.endsWith('_API_KEY')) continue;
    out[k] = v;
  }
  return out;
}

/** Validate raw config against DEFAULT_CONFIG, rejecting unknown keys. */
export function validateConfig(raw = {}) {
  return mergeValidated(DEFAULT_CONFIG, raw, 'config');
}

function mergeValidated(defaults, raw, path) {
  if (raw == null) return structuredClone(defaults);
  const result = structuredClone(defaults);
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new Error(`Unknown config key: ${path}.${key}`);
    }
    const dflt = defaults[key];
    result[key] = isPlainObject(dflt) ? mergeValidated(dflt, value, `${path}.${key}`) : value;
  }
  return result;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Resolve one binary: an explicit `override` wins; otherwise consult `lookup`
 * (name -> absolute path | null). Fails immediately if neither resolves.
 */
export function resolveBinary(name, override, lookup) {
  if (override) return override;
  const found = lookup ? lookup(name) : null;
  if (!found) {
    throw new Error(
      `Required binary not found: ${name} (no config override and not resolved on PATH)`,
    );
  }
  return found;
}

const BINARY_NAMES = { claude: 'claude', codex: 'codex', taskMaster: 'task-master' };

/**
 * Resolve all three CLIs to absolute paths, using config overrides and, for the
 * rest, `where` (Windows) / `which` via the injected runner. Throws naming any
 * binary that cannot be resolved.
 */
export async function resolveAllBinaries(config, runProcess = defaultRunProcess) {
  const out = {};
  for (const [key, binName] of Object.entries(BINARY_NAMES)) {
    const override = config?.binaries?.[key] ?? null;
    if (override) {
      out[key] = override;
      continue;
    }
    const path = await whichBinary(binName, runProcess);
    out[key] = resolveBinary(binName, null, () => path);
  }
  return out;
}

async function whichBinary(name, runProcess) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = await runProcess(finder, [name]);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  const lines = res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    // `where` lists the extensionless npm Unix shim first; spawn() can't run it.
    // Prefer a real Windows-executable variant (.cmd/.exe/.bat).
    return lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) ?? lines[0];
  }
  return lines[0];
}

/** Headless claude probe args — print mode, JSON; never `--bare` (that forces API key). */
export function buildClaudeProbeArgs(prompt = 'Reply with exactly: OK') {
  return ['-p', prompt, '--output-format', 'json'];
}

/** Non-interactive codex probe args — read-only sandbox, approval never. */
export function buildCodexProbeArgs(prompt = 'Reply with exactly: OK and nothing else.') {
  return ['exec', '-s', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', prompt];
}

function probeOk(res) {
  return !!res && res.code === 0 && !res.timedOut && !res.error;
}

/**
 * Run a trivial round-trip against both agents under the sanitized env to
 * confirm subscription auth works before a real run. codex gets `input: ''`
 * so proc.js closes stdin (codex exec otherwise blocks on stdin).
 */
export async function runStartupProbe({ runProcess = defaultRunProcess, claudeBin, codexBin, env }) {
  const claudeRes = await runProcess(claudeBin, buildClaudeProbeArgs(), { env });
  const codexRes = await runProcess(codexBin, buildCodexProbeArgs(), { env, input: '' });
  return {
    claude: { ok: probeOk(claudeRes), result: claudeRes },
    codex: { ok: probeOk(codexRes), result: codexRes },
  };
}
