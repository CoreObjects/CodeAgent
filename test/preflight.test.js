import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPython3Stub,
  pickPython,
  resolvePython,
  PITFALLS,
  formatPitfallsForPrompt,
  runPreflight,
} from '../src/preflight.js';

// REQ-019 / task 4: environment preflight.

// --- 4.1 python interpreter detection ------------------------------------

test('isPython3Stub recognizes the Microsoft Store stub (exit 49, no output)', () => {
  assert.equal(isPython3Stub({ code: 49, stdout: '', stderr: '', error: null }), true);
});

test('isPython3Stub is false for a real interpreter reporting a version', () => {
  assert.equal(isPython3Stub({ code: 0, stdout: 'Python 3.10.7', stderr: '', error: null }), false);
});

test('pickPython chooses python when it reports a version', () => {
  const r = pickPython(
    { code: 0, stdout: 'Python 3.10.7', stderr: '', error: null },
    { code: 49, stdout: '', stderr: '', error: null },
  );
  assert.equal(r.command, 'python');
  assert.equal(r.version, '3.10.7');
});

test('pickPython falls back to python3 when python is absent and python3 is real', () => {
  const r = pickPython(
    { code: null, stdout: '', stderr: '', error: { code: 'ENOENT' } },
    { code: 0, stdout: 'Python 3.12.1', stderr: '', error: null },
  );
  assert.equal(r.command, 'python3');
});

test('pickPython throws a clear message when python is absent and python3 is the stub', () => {
  assert.throws(
    () =>
      pickPython(
        { code: null, stdout: '', stderr: '', error: { code: 'ENOENT' } },
        { code: 49, stdout: '', stderr: '', error: null },
      ),
    /stub/i,
  );
});

test('resolvePython returns the real interpreter and PYTHONUTF8=1 in its env', async () => {
  const fakeRun = async (bin) =>
    bin === 'python'
      ? { code: 0, stdout: 'Python 3.10.7', stderr: '', error: null, timedOut: false }
      : { code: 49, stdout: '', stderr: '', error: null, timedOut: false };
  const r = await resolvePython(fakeRun);
  assert.equal(r.command, 'python');
  assert.equal(r.env.PYTHONUTF8, '1');
});

// --- 4.4 structured pitfalls record --------------------------------------

test('PITFALLS records the verified pitfalls by id', () => {
  const ids = PITFALLS.map((p) => p.id);
  for (const id of ['python3-stub', 'gbk-locale', 'taskmaster-hyphen', 'cmd-vs-exe', 'codex-stdin-eof', 'agent-sdk-provider-hangs']) {
    assert.ok(ids.includes(id), `missing pitfall: ${id}`);
  }
});

test('formatPitfallsForPrompt renders each pitfall as problem -> workaround text', () => {
  const text = formatPitfallsForPrompt();
  assert.match(text, /stdin/i);
  assert.match(text, /task-master/);
  assert.equal(text.split('\n').length, PITFALLS.length);
});

// --- 4.2 wired preflight --------------------------------------------------

test('runPreflight reports python, resolved binaries, and an ok probe (fakes)', async () => {
  const fakeRun = async (bin, args = []) => {
    if (bin === 'python') return { code: 0, stdout: 'Python 3.10.7', stderr: '', error: null, timedOut: false };
    if (bin === 'python3') return { code: 49, stdout: '', stderr: '', error: null, timedOut: false };
    if (bin === 'where' || bin === 'which')
      return { code: 0, stdout: `C:/npm/${args[0]}.cmd`, stderr: '', error: null, timedOut: false };
    return { code: 0, stdout: 'OK', stderr: '', error: null, timedOut: false }; // probe round-trips
  };
  const r = await runPreflight({ runProcess: fakeRun });
  assert.equal(r.python.command, 'python');
  assert.equal(r.ok, true);
  assert.equal(r.probe.claude.ok, true);
  assert.equal(r.probe.codex.ok, true);
  assert.ok(r.pitfalls.length > 0);
});
