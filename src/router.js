// router.js — REQ-007
// The verdict router is the PROOF that the orchestrator is dumb plumbing: a pure,
// total switch over the verdict enum. It reads ONLY `verdict` and the next-message
// / question fields it forwards — never assessment, cited_evidence, fake_done_flag,
// or any ground-truth field. The orchestrator cannot tell a good `continue` from a
// bad one; all judgment lives in codex.

/**
 * Map a codex decision to exactly one tagged orchestrator action.
 * @returns {{kind:'continue'|'redirect'|'task_complete'|'escalate'|'abort', message?:string, question?:string}}
 */
export function route(decision) {
  switch (decision.verdict) {
    case 'continue':
      return { kind: 'continue', message: decision.message_to_claude };
    case 'redirect':
      return { kind: 'redirect', message: decision.message_to_claude };
    case 'task_complete':
      return { kind: 'task_complete' };
    case 'escalate':
      return { kind: 'escalate', question: decision.escalation_question };
    case 'abort':
      return { kind: 'abort' };
    default:
      throw new Error(`router: unknown verdict: ${decision.verdict}`);
  }
}
