import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeTurnArgs,
  normalizeClaudeTurn,
  runClaudeTurn,
} from '../src/claude-runner.js';

// REQ-003: Claude Code one-turn runner. Tests use recorded stream-json transcripts.

// A recorded stream-json transcript: init -> assistant(text+tool_use) -> tool_result -> assistant(text) -> result.
const TRANSCRIPT = [
  '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-opus","tools":["Read","Edit"]}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Adding it."},{"type":"tool_use","id":"tu1","name":"Edit","input":{"file":"x.js"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","is_error":false,"content":"ok"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}',
  '{"type":"result","subtype":"success","result":"Done.","num_turns":2,"total_cost_usd":0.1,"session_id":"sess-1","usage":{"input_tokens":10,"output_tokens":5}}',
  '',
].join('\n');

const fakeRunFrom = (stdout, extra = {}) => async () => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  error: null,
  ...extra,
});

// --- 5.1 argument builder ------------------------------------------------

test('args always include stream-json + verbose and never --bare', () => {
  const a = buildClaudeTurnArgs('do it', {});
  assert.ok(a.includes('--output-format') && a.includes('stream-json'));
  assert.ok(a.includes('--verbose'));
  assert.ok(!a.includes('--bare'));
  assert.ok(a.includes('-p') && a.includes('do it'));
});

test('first turn omits --resume; a resumed turn passes --resume <session_id>', () => {
  assert.ok(!buildClaudeTurnArgs('x', {}).includes('--resume'));
  const a = buildClaudeTurnArgs('x', { sessionId: 'sess-9' });
  const i = a.indexOf('--resume');
  assert.ok(i !== -1 && a[i + 1] === 'sess-9');
});

test('permission mode and allow-list are passed for non-interactive runs', () => {
  const a = buildClaudeTurnArgs('x', { permissionMode: 'acceptEdits', allowedTools: ['Read', 'Edit'] });
  const pi = a.indexOf('--permission-mode');
  assert.equal(a[pi + 1], 'acceptEdits');
  assert.ok(a.includes('--allowedTools'));
});

// --- 5.3 turn normalization ----------------------------------------------

test('normalizeClaudeTurn extracts sessionId, finalText, tool-uses, tool-results, result event', () => {
  const events = TRANSCRIPT.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const t = normalizeClaudeTurn(events);
  assert.equal(t.sessionId, 'sess-1');
  assert.equal(t.finalText, 'Done.');
  assert.equal(t.toolUseCalls.length, 1);
  assert.equal(t.toolUseCalls[0].name, 'Edit');
  assert.equal(t.toolResults.length, 1);
  assert.equal(t.toolResults[0].isError, false);
  assert.equal(t.resultEvent.subtype, 'success');
});

test('normalizeClaudeTurn flags a tool result error via is_error', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } },
  ];
  const t = normalizeClaudeTurn(events);
  assert.equal(t.toolResults[0].isError, true);
});

// --- 5.5 integration + 5.4 termination -----------------------------------

test('runClaudeTurn returns a normalized turn and terminationReason=result', async () => {
  const t = await runClaudeTurn({ runProcess: fakeRunFrom(TRANSCRIPT), claudeBin: 'claude', instruction: 'go' });
  assert.equal(t.sessionId, 'sess-1');
  assert.equal(t.terminationReason, 'result');
  assert.equal(t.toolUseCalls[0].name, 'Edit');
});

test('runClaudeTurn passes --resume on a resumed turn', async () => {
  let captured;
  const runProcess = async (bin, args) => {
    captured = args;
    return { code: 0, stdout: TRANSCRIPT, stderr: '', timedOut: false, error: null };
  };
  await runClaudeTurn({ runProcess, claudeBin: 'claude', instruction: 'go', sessionId: 'sess-1' });
  assert.ok(captured.includes('--resume'));
});

test('runClaudeTurn reports terminationReason=timeout when no result event and timed out', async () => {
  const partial = '{"type":"system","subtype":"init","session_id":"s2"}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]}}\n';
  const t = await runClaudeTurn({
    runProcess: fakeRunFrom(partial, { code: null, timedOut: true }),
    claudeBin: 'claude',
    instruction: 'go',
  });
  assert.equal(t.terminationReason, 'timeout');
  assert.equal(t.sessionId, 's2');
});

test('runClaudeTurn throws when the stream has no init/session_id (hard error)', async () => {
  const noInit = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n';
  await assert.rejects(
    () => runClaudeTurn({ runProcess: fakeRunFrom(noInit), claudeBin: 'claude', instruction: 'go' }),
    /session/i,
  );
});
