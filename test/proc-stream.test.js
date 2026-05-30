import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/proc.js';

// proc.js gains an optional onStdout(chunk) callback so callers can stream output
// live. It must still buffer stdout into the result exactly as before.

test('onStdout receives chunks whose concatenation equals the buffered stdout', async () => {
  const chunks = [];
  const res = await runProcess(
    process.execPath,
    ['-e', "process.stdout.write('hello'); process.stdout.write('world')"],
    { onStdout: (c) => chunks.push(c) },
  );
  assert.equal(res.code, 0);
  assert.equal(chunks.join(''), res.stdout);
  assert.match(res.stdout, /helloworld/);
});

test('onStdout is optional — omitting it still buffers stdout', async () => {
  const res = await runProcess(process.execPath, ['-e', "process.stdout.write('ok')"]);
  assert.match(res.stdout, /ok/);
});
