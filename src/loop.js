// loop.js — v4: phase-driven control loop.
//
// The worker (claude) SELF-DRIVES a whole PRD phase and ends each message with a
// STATUS marker. We parse it MECHANICALLY (no LLM) and route cheaply:
//   WORKING            -> auto-continue (NO codex — this is where token is saved)
//   BLOCKED            -> codex/human decides, answer relayed to the worker
//   CHECKPOINT_REACHED -> codex deep-verifies THIS checkpoint (the examiner) ->
//                         pass: proceed to next phase (fresh session) ;
//                         reject: relay the required fixes, worker resumes
//   PROJECT_COMPLETE   -> return 'done' (the wrapper runs the final acceptance)
//
// codex is invoked only at checkpoints and the rare block — not every turn. The
// mechanical safety net (ground truth + stall guard) still runs every turn for
// free. Every collaborator is injected, so the loop is fully testable.

export async function runLoop(deps) {
  const {
    runWorkerTurn,
    classifyReport,
    snapshotStart,
    collect,
    observeProgress = () => {},
    stallGuard = () => null,
    verifyCheckpoint,
    decideBlock,
    memo,
    askHuman,
    logTurn = () => {},
    onCheckpoint = () => {},
    beginInstruction,
    continueInstruction = 'Continue working toward the current phase checkpoint.',
    maxTurns = 200,
  } = deps;

  let sessionId = null;
  let instruction = beginInstruction;
  let turns = 0;

  for (;;) {
    turns += 1;
    if (turns > maxTurns) {
      const ans = await askHuman(`Turn cap (${maxTurns}) reached without project completion. Continue or abort?`);
      if (/\babort\b/i.test(ans)) return { reason: 'abort', turns };
      turns = 1;
    }

    const snapshot = await snapshotStart();
    const turn = await runWorkerTurn({ instruction, sessionId });
    sessionId = turn.sessionId ?? sessionId;

    const groundTruth = await collect(snapshot);
    observeProgress(groundTruth);
    const report = classifyReport(turn.finalText);
    logTurn({ turnIndex: turns, workerStream: turn, groundTruth, report });

    // Mechanical stall guard (free, no LLM) — surfaces a spin to the human, never judges.
    const stall = stallGuard();
    if (stall?.escalate) {
      const ans = await askHuman(stall.question);
      memo.write(`${memo.read()}\n\n[HUMAN — ${stall.question}] ${ans}`);
      if (/\babort\b/i.test(ans)) return { reason: 'abort', turns };
      instruction = ans || continueInstruction;
      continue;
    }

    switch (report.status) {
      case 'done':
        return { reason: 'done', turns }; // wrapper runs the final whole-project acceptance

      case 'working':
        instruction = continueInstruction; // NO codex
        break;

      case 'blocked': {
        const action = await decideBlock({ question: report.detail, groundTruth });
        if (action.kind === 'abort') return { reason: 'abort', turns };
        if (action.kind === 'escalate') {
          const ans = await askHuman(action.question);
          memo.write(`${memo.read()}\n\n[HUMAN ANSWER — ${action.question}] ${ans}`);
          instruction = ans; // relay the human's answer to the worker so it can proceed
        } else {
          instruction = action.message; // codex answered the block — relay verbatim
        }
        break;
      }

      case 'checkpoint': {
        const v = await verifyCheckpoint({ checkpoint: report.detail, groundTruth });
        onCheckpoint({ checkpoint: report.detail, decision: v });
        memo.write(`${memo.read()}\n\n[CHECKPOINT "${report.detail}" ${v.accept ? 'PASSED' : 'REJECTED'}] ${v.report ?? ''}`);
        if (v.accept) {
          sessionId = null; // fresh worker session per phase — bounds the transcript (token)
          instruction = `Checkpoint "${report.detail}" was verified and PASSED. Proceed to the next phase / checkpoint per the PRD.`;
        } else {
          const fixes = (v.fix_tasks ?? []).map((f, i) => `${i + 1}. ${f.title}: ${f.description}`).join('\n');
          instruction = `Checkpoint "${report.detail}" did NOT pass review:\n${v.report ?? ''}\nFix the following, then report again:\n${fixes}`;
        }
        break;
      }
    }
  }
}
