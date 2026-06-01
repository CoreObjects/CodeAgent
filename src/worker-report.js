// worker-report.js — v4
// The worker (claude) self-drives a whole PRD phase and ends each message with a
// STATUS marker. The orchestrator parses it MECHANICALLY (no LLM, no tokens) to
// route: WORKING -> auto-continue; CHECKPOINT_REACHED -> codex checkpoint verify;
// BLOCKED -> codex/human; PROJECT_COMPLETE -> final whole-project acceptance.
//
// This is the cheap routing that lets codex be invoked only at checkpoints
// (the examiner), instead of every turn.

/**
 * @param {string} finalText  the worker's final message text
 * @returns {{status:'checkpoint'|'working'|'blocked'|'done', detail:string}}
 */
export function classifyWorkerReport(finalText) {
  const text = String(finalText ?? '');
  const matches = [...text.matchAll(/STATUS:\s*(CHECKPOINT_REACHED|PROJECT_COMPLETE|WORKING|BLOCKED)\b:?\s*([^\n]*)/gi)];
  if (matches.length === 0) return { status: 'working', detail: '' }; // conservative: keep going
  const m = matches[matches.length - 1]; // the last marker wins
  const kind = m[1].toUpperCase();
  const detail = (m[2] ?? '').trim();
  if (kind === 'CHECKPOINT_REACHED') return { status: 'checkpoint', detail };
  if (kind === 'PROJECT_COMPLETE') return { status: 'done', detail };
  if (kind === 'BLOCKED') return { status: 'blocked', detail };
  return { status: 'working', detail };
}
