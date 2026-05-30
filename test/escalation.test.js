import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { formatEscalationBlock, createEscalationChannel } from '../src/escalation.js';

// REQ-011: the human escalation channel. On a codex `escalate` verdict the loop
// calls askHuman(question); this module presents the question in a delimited
// console block, BLOCKS on one typed line, optionally fires a desktop
// notification (degrading silently), records the exchange, and returns the
// answer verbatim. It makes NO decision — routing the answer back to codex (not
// the worker) is the loop's job, already covered in loop.test.js.

function collector() {
  const chunks = [];
  const output = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  return { output, text: () => chunks.join('') };
}

test('formatEscalationBlock wraps the question in a clearly delimited block', () => {
  const block = formatEscalationBlock('Pick A or B');
  assert.match(block, /ESCALATION/);
  assert.match(block, /Pick A or B/);
  const delims = block.split('\n').filter((l) => /─{10,}/.test(l));
  assert.ok(delims.length >= 2, 'expected at least two delimiter lines');
});

test('askHuman prints the delimited block and returns the typed line verbatim', async () => {
  const input = new PassThrough();
  const { output, text } = collector();
  const { askHuman } = createEscalationChannel({ input, output });
  const p = askHuman('A or B?');
  input.write('B please\n');
  const answer = await p;
  assert.equal(answer, 'B please');
  const printed = text();
  assert.match(printed, /ESCALATION/);
  assert.match(printed, /A or B\?/);
});

test('askHuman strips a trailing CR (Windows CRLF) from the answer', async () => {
  const input = new PassThrough();
  const { output } = collector();
  const { askHuman } = createEscalationChannel({ input, output });
  const p = askHuman('Q?');
  input.write('answer\r\n');
  assert.equal(await p, 'answer');
});

test('blocks until input arrives (does not resolve before a line is typed)', async () => {
  const input = new PassThrough();
  const { output } = collector();
  const { askHuman } = createEscalationChannel({ input, output });
  let resolved = false;
  const p = askHuman('waiting?').then((a) => {
    resolved = true;
    return a;
  });
  // give the event loop a few ticks with no input — must still be pending
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false);
  input.write('now\n');
  assert.equal(await p, 'now');
  assert.equal(resolved, true);
});

test('records the question and answer for the transcript', async () => {
  const input = new PassThrough();
  const { output } = collector();
  const recorded = [];
  const { askHuman } = createEscalationChannel({ input, output, record: (e) => recorded.push(e) });
  const p = askHuman('scope: even or isEven?');
  input.write('isEven\n');
  await p;
  assert.deepEqual(recorded, [{ question: 'scope: even or isEven?', answer: 'isEven' }]);
});

test('fires the optional desktop notification, degrading silently when it throws', async () => {
  const input = new PassThrough();
  const { output } = collector();
  let notified = null;
  const { askHuman } = createEscalationChannel({
    input,
    output,
    notify: (n) => {
      notified = n;
      throw new Error('no notifier installed'); // must NOT break the pause
    },
  });
  const p = askHuman('Q?');
  input.write('ans\n');
  const a = await p;
  assert.equal(a, 'ans'); // still works despite notify throwing
  assert.deepEqual(notified, { title: 'Supervisor escalation', message: 'Q?' });
});

test('a throwing record hook does not break the pause', async () => {
  const input = new PassThrough();
  const { output } = collector();
  const { askHuman } = createEscalationChannel({
    input,
    output,
    record: () => {
      throw new Error('disk full');
    },
  });
  const p = askHuman('Q?');
  input.write('still works\n');
  assert.equal(await p, 'still works');
});
