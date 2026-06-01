import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../src/proc.js';
import { parseShortstat, snapshotStart, collect } from '../src/ground-truth.js';

// REQ-004: ground-truth collector — observe-only, no interpretation.

// --- parseShortstat (pure) -----------------------------------------------

test('parseShortstat reads files/insertions/deletions', () => {
  assert.deepEqual(parseShortstat(' 2 files changed, 10 insertions(+), 3 deletions(-)'), {
    filesChanged: 2,
    insertions: 10,
    deletions: 3,
  });
});

test('parseShortstat handles a single insertion-only change', () => {
  assert.deepEqual(parseShortstat(' 1 file changed, 5 insertions(+)'), {
    filesChanged: 1,
    insertions: 5,
    deletions: 0,
  });
});

test('parseShortstat returns zeros for empty (no changes)', () => {
  assert.deepEqual(parseShortstat(''), { filesChanged: 0, insertions: 0, deletions: 0 });
});

// --- snapshot + collect with a fake git runner ---------------------------

function fakeGit(map) {
  return async (bin, args = []) => {
    const key = args.join(' ');
    for (const [prefix, out] of Object.entries(map)) {
      if (key.startsWith(prefix)) return { code: 0, stdout: out, stderr: '', timedOut: false, error: null };
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
  };
}

test('snapshotStart records HEAD and porcelain before the turn', async () => {
  const run = fakeGit({ 'rev-parse HEAD': 'abc123\n', 'status --porcelain': ' M x.js\n' });
  const snap = await snapshotStart({ runProcess: run, cwd: '.' });
  assert.equal(snap.head, 'abc123');
  assert.equal(snap.porcelain, ' M x.js\n');
});

test('collect scopes changed files to the pre-turn HEAD and parses diff stats', async () => {
  const run = fakeGit({
    'diff --shortstat': ' 2 files changed, 4 insertions(+), 1 deletion(-)',
    'diff --name-only': 'src/a.js\nsrc/b.js\n',
    'status --porcelain': '',
    'rev-parse HEAD': 'def456\n',
  });
  const gt = await collect({ runProcess: run, cwd: '.', snapshot: { head: 'abc123' } });
  assert.equal(gt.headBefore, 'abc123');
  assert.deepEqual(gt.changedFiles, ['src/a.js', 'src/b.js']);
  assert.equal(gt.diffStat.filesChanged, 2);
  assert.equal(gt.test, undefined); // no testCommand -> field omitted
});

test('collect runs the test command and passes a non-zero exit code through faithfully', async () => {
  const run = async (bin, args = []) => {
    if (bin === 'git') return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    return { code: 1, stdout: 'FAIL: 1 test failed', stderr: '', timedOut: false, error: null };
  };
  const gt = await collect({ runProcess: run, cwd: '.', snapshot: { head: 'abc' }, testCommand: ['node', '--test'] });
  assert.equal(gt.test.ran, true);
  assert.equal(gt.test.exitCode, 1);
  assert.match(gt.test.outputTail, /FAIL/);
});

test('collect applies a timeout (+env) to the test command so a hung/GUI test cannot block forever', async () => {
  let seen = null;
  const run = async (bin, args = [], opts = {}) => {
    if (bin === 'git') return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    seen = opts;
    return { code: 0, stdout: 'ok', stderr: '', timedOut: false, error: null };
  };
  await collect({ runProcess: run, cwd: '.', snapshot: { head: 'abc' }, testCommand: ['python', '-m', 'pytest'], testTimeoutMs: 600000, env: { QT_QPA_PLATFORM: 'offscreen' } });
  assert.equal(seen.timeoutMs, 600000);
  assert.equal(seen.env.QT_QPA_PLATFORM, 'offscreen');
});

// --- scratch-repo integration --------------------------------------------

test('integration: changed-file list is scoped to the pre-turn HEAD (scratch git repo)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  const git = (...a) => runProcess('git', a, { cwd: dir, env });
  try {
    await git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');

    const snap = await snapshotStart({ runProcess, cwd: dir });
    assert.ok(snap.head.length >= 7);

    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'edit');

    const gt = await collect({ runProcess, cwd: dir, snapshot: snap });
    assert.ok(gt.changedFiles.includes('a.txt'), `expected a.txt in ${gt.changedFiles}`);
    assert.ok(gt.changedFiles.includes('b.txt'), `expected b.txt in ${gt.changedFiles}`);
    assert.ok(gt.diffStat.filesChanged >= 2);
    assert.equal(gt.committed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
