// claude-runner.js — REQ-003
// Run Claude Code for exactly ONE worker turn in headless mode and return a
// normalized turn object. Consumes proc.js (REQ-001) and the NDJSON parser
// (REQ-002). The turn boundary is the stream-json `result` event (or process
// exit / timeout) — never a stop_reason inside an assistant event.
//
// Sessions continue across turns: the session id captured from the init event
// is passed as `--resume <id>` on the next turn. Never pass `--bare` (API-key auth).

import { runProcess as defaultRunProcess } from './proc.js';
import { NdjsonParser } from './stream-parser.js';

/** Build claude argv for one headless turn. (subtask 5.1) */
export function buildClaudeTurnArgs(
  instruction,
  { sessionId = null, permissionMode = 'acceptEdits', allowedTools = [] } = {},
) {
  const args = ['-p', instruction, '--output-format', 'stream-json', '--verbose'];
  if (sessionId) args.push('--resume', sessionId);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(' '));
  return args;
}

/**
 * Reduce parsed stream-json events into a normalized turn (subtasks 5.2, 5.3):
 *   { sessionId, finalText, toolUseCalls, toolResults, resultEvent }
 * Ordering inside arrays is preserved. Contents are not interpreted — that is
 * codex's job; this only reports what the worker said and did.
 */
export function normalizeClaudeTurn(events) {
  let sessionId = null;
  const assistantTexts = [];
  const toolUseCalls = [];
  const toolResults = [];
  let resultEvent = null;

  for (const ev of events) {
    if (ev.type === 'system' && ev.subtype === 'init') {
      sessionId = ev.session_id ?? sessionId;
    } else if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text') assistantTexts.push(block.text ?? '');
        else if (block.type === 'tool_use') {
          toolUseCalls.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    } else if (ev.type === 'user') {
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'tool_result') {
          toolResults.push({
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            content: block.content,
          });
        }
      }
    } else if (ev.type === 'result') {
      resultEvent = ev;
      sessionId = sessionId ?? ev.session_id ?? null;
    }
  }

  const finalText = resultEvent?.result ?? assistantTexts.join('');
  return { sessionId, finalText, toolUseCalls, toolResults, resultEvent };
}

/**
 * Run one claude turn end-to-end (subtask 5.5). Returns the normalized turn plus
 * `terminationReason` ('result' | 'timeout' | 'exit'), exitCode and timedOut.
 * stdin is closed (input: '') so claude never blocks waiting for input.
 */
export async function runClaudeTurn({
  runProcess = defaultRunProcess,
  claudeBin,
  instruction,
  sessionId = null,
  permissionMode = 'acceptEdits',
  allowedTools = [],
  env,
  timeoutMs,
  onEvent,
}) {
  const args = buildClaudeTurnArgs(instruction, { sessionId, permissionMode, allowedTools });

  // Parse stream-json incrementally as stdout arrives, so onEvent fires LIVE.
  const parser = new NdjsonParser();
  const events = [];
  const consume = (results) => {
    for (const r of results) {
      if (r.type === 'json') {
        events.push(r.value);
        if (onEvent) onEvent(r.value);
      }
    }
  };

  const res = await runProcess(claudeBin, args, {
    env,
    timeoutMs,
    input: '',
    onStdout: (chunk) => consume(parser.push(chunk)),
  });
  consume(parser.flush());

  // Fallback: if runProcess delivered stdout without streaming (e.g. a test fake
  // that returns { stdout } and never calls onStdout), parse the buffer now.
  if (events.length === 0 && res.stdout) {
    const p2 = new NdjsonParser();
    consume(p2.push(res.stdout));
    consume(p2.flush());
  }

  const turn = normalizeClaudeTurn(events);
  if (!turn.sessionId) {
    throw new Error('claude stream had no init/session_id — later turns cannot resume');
  }

  // The result event is the canonical turn boundary (subtask 5.4).
  const terminationReason = turn.resultEvent ? 'result' : res.timedOut ? 'timeout' : 'exit';
  return { ...turn, terminationReason, exitCode: res.code, timedOut: res.timedOut };
}
