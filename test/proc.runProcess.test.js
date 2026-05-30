import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runProcess } from '../src/proc.js';

// REQ-001 / subtasks 1.2-1.4: spawn, stdin handling, timeout+kill-tree, result normalization.

const node = process.execPath;
const FAKE_CMD = path.join(import.meta.dirname, 'fixtures', 'fake.cmd');

test('spawns a direct binary and captures stdout with exit code 0', async () => {
  const r = await runProcess(node, ['-e', "process.stdout.write('hi')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
  assert.equal(r.timedOut, false);
  assert.equal(r.error, null);
});

test('captures stderr separately and preserves a non-zero exit code', async () => {
  const r = await runProcess(node, ['-e', "process.stderr.write('boom'); process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'boom');
  assert.equal(r.stdout, '');
});

test('spawns a .cmd shim via cmd.exe /c without ENOENT', async () => {
  const r = await runProcess(FAKE_CMD, []);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-from-cmd/);
  assert.equal(r.error, null);
});

test('a missing binary is normalized to the same shape (no throw): code null + structured error', async () => {
  const r = await runProcess('definitely-not-a-real-binary-xyz', []);
  assert.equal(r.code, null);
  assert.ok(r.error, 'expected a structured error field');
  assert.equal(r.timedOut, false);
  assert.equal(typeof r.durationMs, 'number');
});

test('closes stdin by default so a stdin-reading child reaches EOF and exits (no hang)', async () => {
  // If stdin were left open this child blocks forever — exactly the codex-exec stall we hit.
  const r = await runProcess(
    node,
    ['-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('EOF:'+d))"],
    { timeoutMs: 5000 },
  );
  assert.equal(r.timedOut, false);
  assert.equal(r.stdout, 'EOF:');
});

test('pipes provided input to stdin', async () => {
  const r = await runProcess(
    node,
    ['-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('GOT:'+d))"],
    { input: 'payload' },
  );
  assert.equal(r.stdout, 'GOT:payload');
});

test('timeout fires, terminates the whole process tree, and returns timedOut=true promptly', async () => {
  // Parent spawns a long-sleeping grandchild and itself sleeps 60s; the timeout must kill both.
  const code =
    "const cp=require('node:child_process'); cp.spawn(process.execPath,['-e','setTimeout(()=>{},60000)']); setTimeout(()=>{},60000);";
  const r = await runProcess(node, ['-e', code], { timeoutMs: 800 });
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 10000, `expected prompt resolution after kill, got ${r.durationMs}ms`);
});
