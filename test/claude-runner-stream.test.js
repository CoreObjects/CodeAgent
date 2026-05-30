import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeTurn } from '../src/claude-runner.js';

// claude-runner gains an optional onEvent(event) callback that fires LIVE as
// stream-json events arrive (parsed incrementally, tolerant of mid-line chunk
// splits). The normalized turn is unchanged.

test('streams parsed events to onEvent as stdout arrives in chunks', async () => {
  const lines =
    [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'hi', session_id: 's1' }),
    ].join('\n') + '\n';
  // deliberately split mid-line to exercise incremental parsing
  const chunks = [lines.slice(0, 12), lines.slice(12, 70), lines.slice(70)];

  const seen = [];
  const runProcess = async (_bin, _args, opts) => {
    for (const c of chunks) opts.onStdout(c);
    return { code: 0, stdout: lines, stderr: '', timedOut: false, error: null };
  };

  const turn = await runClaudeTurn({ runProcess, claudeBin: 'C', instruction: 'x', onEvent: (e) => seen.push(e) });
  assert.equal(turn.sessionId, 's1');
  assert.equal(turn.finalText, 'hi');
  assert.equal(seen.length, 3); // three json events streamed live
  assert.equal(seen[0].type, 'system');
  assert.equal(seen[2].type, 'result');
});

test('still works when runProcess delivers stdout without streaming (fallback)', async () => {
  const lines =
    [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's9' }), JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 's9' })].join('\n') + '\n';
  const runProcess = async () => ({ code: 0, stdout: lines, stderr: '', timedOut: false, error: null });
  const turn = await runClaudeTurn({ runProcess, claudeBin: 'C', instruction: 'x' });
  assert.equal(turn.sessionId, 's9');
  assert.equal(turn.terminationReason, 'result');
});
