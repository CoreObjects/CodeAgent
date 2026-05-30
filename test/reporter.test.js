import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleReporter } from '../src/reporter.js';

// The live reporter streams the worker's actions and the supervisor's verdicts to
// the console as the run progresses. It writes to an injected stream so the test
// captures output. No decisions — pure rendering.

function cap() {
  const chunks = [];
  return { out: { write: (s) => chunks.push(String(s)) }, text: () => chunks.join('') };
}

test('taskStart prints the task number, total, and title', () => {
  const { out, text } = cap();
  createConsoleReporter({ out }).taskStart({ task: { id: '3', title: 'ExpressionParser' }, index: 3, total: 12 });
  assert.match(text(), /3\/12/);
  assert.match(text(), /ExpressionParser/);
});

test('workerEvent renders a tool_use as a bullet with its target', () => {
  const { out, text } = cap();
  const r = createConsoleReporter({ out });
  r.workerEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'lib/math.js' } }] } });
  r.workerEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'python -m pytest -q' } }] } });
  const t = text();
  assert.match(t, /Edit/);
  assert.match(t, /lib\/math\.js/);
  assert.match(t, /Bash/);
  assert.match(t, /pytest/);
});

test('workerEvent renders assistant text and flags tool errors', () => {
  const { out, text } = cap();
  const r = createConsoleReporter({ out });
  r.workerEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implementing sum now' }] } });
  r.workerEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom' }] } });
  const t = text();
  assert.match(t, /Implementing sum now/);
  assert.match(t, /error|✗/i);
});

test('turn prints the codex verdict, the ground-truth diff, and the relayed message', () => {
  const { out, text } = cap();
  createConsoleReporter({ out }).turn({
    turnIndex: 2,
    groundTruth: { changedFiles: ['lib/math.js'], test: { exitCode: 0 } },
    decision: { verdict: 'redirect', assessment: 'empty diff vs claim', message_to_claude: 'actually implement it', fake_done_flag: true },
  });
  const t = text();
  assert.match(t, /redirect/);
  assert.match(t, /lib\/math\.js/);
  assert.match(t, /actually implement it/);
});

test('turn shows the escalation question on an escalate verdict', () => {
  const { out, text } = cap();
  createConsoleReporter({ out }).turn({ turnIndex: 4, groundTruth: { changedFiles: [] }, decision: { verdict: 'escalate', escalation_question: 'isEven or even?' } });
  assert.match(text(), /isEven or even\?/);
});

test('quiet mode suppresses worker streaming but still prints turn verdicts', () => {
  const { out, text } = cap();
  const r = createConsoleReporter({ out, quiet: true });
  r.workerEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'lots of noise' }] } });
  assert.equal(text(), '');
  r.turn({ turnIndex: 1, groundTruth: { changedFiles: [] }, decision: { verdict: 'continue', assessment: 'a', message_to_claude: 'go' } });
  assert.match(text(), /continue/);
});

test('done prints the final reason and turn count', () => {
  const { out, text } = cap();
  createConsoleReporter({ out }).done({ reason: 'done', turns: 12 });
  assert.match(text(), /done/);
  assert.match(text(), /12/);
});
