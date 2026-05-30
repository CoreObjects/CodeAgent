import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpawnArgs } from '../src/proc.js';

// REQ-001 / subtask 1.1: argv builder for .cmd shims vs .exe binaries.

test('.cmd shim is launched via cmd.exe /c with the shim and args as discrete elements', () => {
  const r = buildSpawnArgs('C:\\path\\task-master.cmd', ['list']);
  assert.equal(r.command, 'cmd.exe');
  assert.deepEqual(r.args, ['/c', 'C:\\path\\task-master.cmd', 'list']);
});

test('.bat is treated like .cmd', () => {
  const r = buildSpawnArgs('x.bat', ['y']);
  assert.equal(r.command, 'cmd.exe');
  assert.deepEqual(r.args, ['/c', 'x.bat', 'y']);
});

test('.exe is spawned directly without a shell', () => {
  const r = buildSpawnArgs('C:\\path\\codex.exe', ['exec', '--json']);
  assert.equal(r.command, 'C:\\path\\codex.exe');
  assert.deepEqual(r.args, ['exec', '--json']);
});

test('a bare binary name with no extension is spawned directly', () => {
  const r = buildSpawnArgs('node', ['-e', 'process.exit(0)']);
  assert.equal(r.command, 'node');
  assert.deepEqual(r.args, ['-e', 'process.exit(0)']);
});

test('arguments with embedded spaces survive as discrete array elements (no string joining)', () => {
  const r = buildSpawnArgs('foo.cmd', ['--msg', 'hello world', 'a b']);
  assert.deepEqual(r.args, ['/c', 'foo.cmd', '--msg', 'hello world', 'a b']);
});

test('extension detection is case-insensitive (.CMD)', () => {
  const r = buildSpawnArgs('Run.CMD', ['go']);
  assert.equal(r.command, 'cmd.exe');
  assert.deepEqual(r.args, ['/c', 'Run.CMD', 'go']);
});

test('a pre-joined command string passed as args is refused at the boundary', () => {
  assert.throws(() => buildSpawnArgs('foo.exe', 'a b c'), /array/i);
});

test('an empty bin is refused', () => {
  assert.throws(() => buildSpawnArgs('', []), /non-empty/i);
});

test('args default to an empty array when omitted', () => {
  const r = buildSpawnArgs('codex.exe');
  assert.deepEqual(r.args, []);
});
