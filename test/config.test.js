import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeEnv,
  validateConfig,
  DEFAULT_CONFIG,
  resolveBinary,
  resolveAllBinaries,
  pickArchExe,
  buildClaudeProbeArgs,
  buildCodexProbeArgs,
  runStartupProbe,
} from '../src/config.js';

// REQ-012: config, path resolution, env sanitization (subscription enforced), startup probe.

// --- 3.3 env sanitization -------------------------------------------------

test('strips ANTHROPIC_API_KEY, OPENAI_API_KEY and any *_API_KEY variable', () => {
  const env = sanitizeEnv({
    PATH: '/usr/bin',
    PYTHONUTF8: '1',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-openai-secret',
    PERPLEXITY_API_KEY: 'pplx-secret',
    HOME: '/home/me',
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PERPLEXITY_API_KEY, undefined);
});

test('preserves non-key variables (PATH, PYTHONUTF8, HOME)', () => {
  const env = sanitizeEnv({ PATH: '/usr/bin', PYTHONUTF8: '1', HOME: '/home/me' });
  assert.deepEqual(env, { PATH: '/usr/bin', PYTHONUTF8: '1', HOME: '/home/me' });
});

test('does not mutate the input env object', () => {
  const input = { ANTHROPIC_API_KEY: 'x', PATH: '/p' };
  sanitizeEnv(input);
  assert.equal(input.ANTHROPIC_API_KEY, 'x');
});

// --- 3.1 config schema + loader ------------------------------------------

test('validateConfig applies defaults when given an empty object', () => {
  const cfg = validateConfig({});
  assert.equal(cfg.memoMaxChars, DEFAULT_CONFIG.memoMaxChars);
  assert.equal(cfg.timeouts.processMs, DEFAULT_CONFIG.timeouts.processMs);
});

test('validateConfig rejects an unknown top-level key', () => {
  assert.throws(() => validateConfig({ notARealKey: 1 }), /unknown config key.*notARealKey/i);
});

test('validateConfig rejects an unknown nested key under timeouts', () => {
  assert.throws(() => validateConfig({ timeouts: { bogusMs: 5 } }), /unknown config key.*bogusMs/i);
});

test('validateConfig overrides a provided value and keeps other defaults', () => {
  const cfg = validateConfig({ memoMaxChars: 8000 });
  assert.equal(cfg.memoMaxChars, 8000);
  assert.equal(cfg.digestMaxChars, DEFAULT_CONFIG.digestMaxChars);
});

// --- 3.2 binary path resolution ------------------------------------------

test('resolveBinary returns an explicit override without consulting lookup', () => {
  let lookedUp = false;
  const r = resolveBinary('codex', 'C:/abs/codex.exe', () => {
    lookedUp = true;
    return null;
  });
  assert.equal(r, 'C:/abs/codex.exe');
  assert.equal(lookedUp, false);
});

test('resolveBinary falls back to the injected lookup when no override', () => {
  const r = resolveBinary('claude', null, (name) => `/resolved/${name}`);
  assert.equal(r, '/resolved/claude');
});

test('resolveBinary fails immediately with a clear message naming the binary', () => {
  assert.throws(() => resolveBinary('task-master', null, () => null), /task-master/);
});

test('resolveAllBinaries resolves via the injected runner (first match) and maps task-master', async () => {
  const fakeRun = async (bin, args) => {
    assert.ok(bin === 'where' || bin === 'which', `expected where/which, got ${bin}`);
    return { code: 0, stdout: `C:/bin/${args[0]}.exe\r\nC:/other/${args[0]}.exe`, stderr: '', timedOut: false, error: null };
  };
  const r = await resolveAllBinaries(validateConfig({}), fakeRun);
  assert.equal(r.codex, 'C:/bin/codex.exe');
  assert.equal(r.claude, 'C:/bin/claude.exe');
  assert.equal(r.taskMaster, 'C:/bin/task-master.exe');
});

test('resolveAllBinaries prefers a .cmd/.exe over the extensionless npm Unix shim (Windows where)', async () => {
  // `where claude` lists the extensionless npm shell script first, then claude.cmd —
  // and spawn() cannot execute the extensionless one on Windows.
  const fakeRun = async (bin, args) => ({
    code: 0,
    stdout: `C:/npm/${args[0]}\r\nC:/npm/${args[0]}.cmd\r\nC:/npm/${args[0]}.ps1`,
    stderr: '',
    timedOut: false,
    error: null,
  });
  const r = await resolveAllBinaries(validateConfig({}), fakeRun);
  assert.equal(r.claude, 'C:/npm/claude.cmd');
  assert.equal(r.codex, 'C:/npm/codex.cmd');
});

test('resolveAllBinaries honors explicit overrides without consulting the lookup', async () => {
  let called = false;
  const fakeRun = async () => {
    called = true;
    return { code: 1, stdout: '', stderr: '', timedOut: false, error: null };
  };
  const cfg = validateConfig({
    binaries: { claude: 'A/claude', codex: 'B/codex.exe', taskMaster: 'C/task-master.cmd' },
  });
  const r = await resolveAllBinaries(cfg, fakeRun);
  assert.deepEqual(r, { claude: 'A/claude', codex: 'B/codex.exe', taskMaster: 'C/task-master.cmd' });
  assert.equal(called, false, 'lookup must not run when all overrides are set');
});

// --- codex/claude .exe upgrade (latency fix) ------------------------------

test('pickArchExe selects the x86_64 windows build on win32/x64', () => {
  const paths = [
    '/p/codex-win32-arm64/vendor/aarch64-pc-windows-msvc/bin/codex.exe',
    '/p/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  ];
  assert.equal(pickArchExe(paths, 'win32', 'x64'), paths[1]);
});

test('pickArchExe selects the aarch64 build on win32/arm64', () => {
  const paths = [
    '/p/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    '/p/vendor/aarch64-pc-windows-msvc/bin/codex.exe',
  ];
  assert.equal(pickArchExe(paths, 'win32', 'arm64'), paths[1]);
});

test('pickArchExe returns null for an empty list', () => {
  assert.equal(pickArchExe([], 'win32', 'x64'), null);
});

test('pickArchExe falls back to the first path when no arch token matches', () => {
  const paths = ['/p/bin/codex.exe', '/p/other/codex.exe'];
  assert.equal(pickArchExe(paths, 'win32', 'x64'), paths[0]);
});

// --- 3.4 startup probe ----------------------------------------------------

test('claude probe args use stream/json print mode and never include --bare', () => {
  const args = buildClaudeProbeArgs();
  assert.ok(args.includes('-p'), 'expected headless print mode');
  assert.ok(!args.includes('--bare'), '--bare would force API-key auth');
});

test('codex probe args run exec read-only with approval never', () => {
  const args = buildCodexProbeArgs();
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('read-only'));
  assert.ok(args.some((a) => /approval_policy="?never"?/.test(a)));
});

test('runStartupProbe reports ok for both agents when the runner succeeds', async () => {
  const fakeRun = async () => ({ code: 0, stdout: 'OK', stderr: '', timedOut: false, error: null });
  const res = await runStartupProbe({ runProcess: fakeRun, claudeBin: 'claude', codexBin: 'codex', env: {} });
  assert.equal(res.claude.ok, true);
  assert.equal(res.codex.ok, true);
});

test('runStartupProbe reports not-ok when a runner returns a non-zero exit', async () => {
  const fakeRun = async (bin) =>
    bin === 'codex'
      ? { code: 1, stdout: '', stderr: 'auth error', timedOut: false, error: null }
      : { code: 0, stdout: 'OK', stderr: '', timedOut: false, error: null };
  const res = await runStartupProbe({ runProcess: fakeRun, claudeBin: 'claude', codexBin: 'codex', env: {} });
  assert.equal(res.claude.ok, true);
  assert.equal(res.codex.ok, false);
});
