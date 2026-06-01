// loop.js — REQ-008
// The per-turn control loop. Pure orchestration: fetch the on-deck task, run one
// worker turn, collect ground truth, build the digest, call codex, persist the
// memo, and route the verdict — repeat until task_complete, then advance.
//
// The ONLY loop-side branches permitted are: turn-completion detection (inside
// runWorkerTurn), the verdict switch, and numeric safety guards that escalate to a
// human. NO deviation taxonomy lives here — all judgment is codex's.
//
// Every collaborator is injected, so the loop is fully testable and carries no
// hidden coupling. main/assembly wires the real modules into these functions.

import { route as defaultRoute } from './router.js';

export async function runLoop(deps) {
  const {
    nextTask,
    setStatus,
    runWorkerTurn,
    snapshotStart,
    collect,
    buildDigest,
    decide,
    memo,
    assemblePrompt,
    renderGoal,
    route = defaultRoute,
    logTurn = () => {},
    askHuman,
    preTurnGuard = () => null,
    observeProgress = () => {},
    onTaskStart = () => {},
    maxTurnsPerTask = 50,
  } = deps;

  let turnIndex = 0;
  let taskIndex = 0;
  let sessionId = null;

  for (;;) {
    const task = await nextTask();
    if (!task) return { reason: 'done', turns: turnIndex };
    taskIndex += 1;
    onTaskStart({ task, taskIndex }); // progress hook for the live reporter — no judgment

    let pendingInstruction = null;
    let taskTurns = 0;
    let advanced = false;
    let aborted = false;

    while (!advanced && !aborted) {
      turnIndex += 1;
      taskTurns += 1;

      // 15.5 numeric pre-turn guard (REQ-016) — a stall surfaces to the human; it never judges.
      const guard = preTurnGuard({ task, taskTurns });
      if (guard?.escalate) {
        const answer = await askHuman(guard.question);
        // route the human's answer back to CODEX (not the worker) via the memo.
        memo.write(`${memo.read()}\n\n[HUMAN ANSWER to non-progress escalation] ${answer}`);
        if (/\babort\b/i.test(answer)) {
          aborted = true; // human's explicit kill switch — not an auto-abort
          break;
        }
      }

      // 15.1 first turn of a task uses the goal; later turns relay codex's message verbatim.
      const instruction = pendingInstruction ?? renderGoal(task);
      const snapshot = await snapshotStart();
      const turn = await runWorkerTurn({ instruction, sessionId });
      sessionId = turn.sessionId ?? sessionId;

      // 15.2 ground truth -> bounded digest -> codex (no interpretation here).
      const groundTruth = await collect(snapshot);
      observeProgress(groundTruth); // REQ-016 — feed the mechanical stall counter
      const { json: evidenceJson, digest } = buildDigest({ turn, groundTruth, task, turnIndex });
      // assemblePrompt may be async (it collects the bounded project map) — await tolerates both.
      const instructions = await assemblePrompt({ goal: renderGoal(task), memo: memo.read() });
      const { decision } = await decide({ instructions, evidenceJson });

      // 15.3 persist memo regardless of verdict (escalations carry it forward too).
      memo.write(decision.updated_memo ?? '');
      logTurn({
        turnIndex,
        workerStream: turn,
        groundTruth,
        evidenceDigest: digest,
        codexPrompt: instructions,
        codexDecision: decision,
      });

      const action = route(decision);
      switch (action.kind) {
        case 'continue':
        case 'redirect':
          pendingInstruction = action.message; // relayed verbatim
          break;
        case 'task_complete':
          await setStatus(task.id, 'done'); // 15.4 — on codex's word, not ours
          advanced = true;
          break;
        case 'escalate': {
          const answer = await askHuman(action.question);
          // route the human's answer back to CODEX (not the worker) via the memo.
          memo.write(`${memo.read()}\n\n[HUMAN ANSWER to escalation: ${action.question}] ${answer}`);
          break;
        }
        case 'abort':
          aborted = true; // 15.4
          break;
      }

      // Numeric turn cap — escalate rather than spin (the only other loop-side branch).
      if (!advanced && !aborted && taskTurns >= maxTurnsPerTask) {
        const answer = await askHuman(`Turn cap (${maxTurnsPerTask}) reached on task ${task.id}. Continue or abort?`);
        if (/abort/i.test(answer)) aborted = true;
        else taskTurns = 0;
      }
    }

    if (aborted) return { reason: 'abort', turns: turnIndex };
  }
}
