// config.js — REQ-012
// Config schema/loader, binary path resolution, env sanitization (subscription
// enforced at the process boundary), and the startup auth probe.
//
// Path resolution and the probe shell out, but ALWAYS through proc.js
// (runProcess) — config.js never touches node:child_process directly.

import fs from 'node:fs';
import path from 'node:path';
import { runProcess as defaultRunProcess } from './proc.js';

export const DEFAULT_CONFIG = {
  // Absolute-path overrides for the three CLIs; null => resolve via where/which.
  binaries: { claude: null, codex: null, taskMaster: null },
  timeouts: { processMs: 120_000, claudeTurnMs: 1_800_000, codexTurnMs: 600_000 },
  memoMaxChars: 6000,
  digestMaxChars: 6000,
  testCommand: null,
  logDir: 'runs',
  // The worker runs in `auto` mode (auto-approve with background safety checks);
  // deny rules still apply. allowedTools is empty so the per-repo
  // .claude/settings.json (provisioned by worker-permissions.js) drives allow/deny
  // instead of being overridden by the CLI --allowedTools flag.
  permissionMode: 'auto',
  allowedTools: [],
  // Run-level recovery for long interruptions (quota/network): wait this long
  // (or the server-hinted reset time) before retrying; give up after N attempts
  // so the run exits cleanly and can be resumed later.
  recoveryWaitMs: 7_200_000, // 2h
  recoveryMaxAttempts: 3,
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
    const found = await whichBinary(binName, runProcess);
    let resolved = resolveBinary(binName, null, () => found);
    // Upgrade codex/claude from the slow `.cmd` node-shim to the vendored `.exe`.
    // The shim path adds ~90s and triggers a model-refresh child-process timeout
    // for codex on Windows; the `.exe` runs directly in ~8s.
    const up = EXE_UPGRADE[key];
    if (up && process.platform === 'win32') {
      const exe = upgradeToExe(resolved, up);
      if (exe) resolved = exe;
    }
    out[key] = resolved;
  }
  return out;
}

// Which npm packages ship a faster native exe worth preferring over the .cmd shim.
const EXE_UPGRADE = {
  codex: { scope: '@openai', pkg: 'codex', exe: 'codex' },
  claude: { scope: '@anthropic-ai', pkg: 'claude-code', exe: 'claude' },
};

// From a resolved `.cmd` shim path, locate the vendored `.exe` under the package.
function upgradeToExe(cmdPath, up) {
  const npmDir = path.dirname(cmdPath);
  const pkgDir = path.join(npmDir, 'node_modules', up.scope, up.pkg);
  return pickArchExe(findExeUnder(pkgDir, up.exe));
}

// Recursively collect every `<baseName>.exe` under `dir` (missing dir -> []).
function findExeUnder(dir, baseName) {
  const target = `${baseName.toLowerCase()}.exe`;
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase() === target) out.push(full);
    }
  }
  return out;
}

/** Pick the exe build matching the current platform+arch; fall back to the first. */
export function pickArchExe(paths, platform = process.platform, arch = process.arch) {
  if (!paths || paths.length === 0) return null;
  const archToken = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const platToken = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'apple' : 'linux';
  const has = (p, tok) => p.toLowerCase().includes(tok);
  return paths.find((p) => has(p, archToken) && has(p, platToken)) ?? paths[0];
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
