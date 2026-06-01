// finalize.js — Phase 3 orchestration (v3)
// Wrap the per-task loop with whole-project acceptance: run the loop to
// completion, then codex deep-reviews the project. accept -> usage doc + done;
// reject -> self-heal (append fix tasks, re-loop) up to maxRounds; past that ->
// escalate to the human with codex's report.
//
// Pure orchestration with every collaborator injected (mirrors loop.js): the
// judgment is codex's (reviewProject); this only mechanically routes the outcome.

import { decideAcceptanceOutcome } from './acceptance.js';

/**
 * @param {{
 *   runLoop: () => Promise<{reason:string,turns?:number}>,
 *   reviewProject: () => Promise<{decision:object}>,
 *   appendFixTasks: (cwd:string, fixTasks:any[]) => void,
 *   writeUsageDoc: () => Promise<any>,
 *   askHuman: (q:string) => Promise<any>,
 *   cwd: string, maxRounds?: number, log?: (m:string)=>void,
 *   decideOutcome?: typeof decideAcceptanceOutcome,
 * }} deps
 */
export async function runWithAcceptance({
  runLoop,
  reviewProject,
  appendFixTasks,
  writeUsageDoc,
  askHuman,
  cwd,
  maxRounds = 2,
  log = () => {},
  decideOutcome = decideAcceptanceOutcome,
}) {
  for (let round = 0; ; round++) {
    const loopResult = await runLoop();
    if (loopResult.reason !== 'done') return loopResult; // aborted — no acceptance

    log('all tasks done — running final acceptance review…');
    const { decision } = await reviewProject();
    const outcome = decideOutcome({ decision, round, maxRounds });

    if (outcome.action === 'accept') {
      log('✓ accepted — writing usage doc…');
      await writeUsageDoc();
      return { reason: 'accepted', turns: loopResult.turns, report: outcome.report };
    }
    if (outcome.action === 'escalate') {
      await askHuman(`Acceptance failed after ${round} self-heal round(s). Report:\n${outcome.report}`);
      return { reason: 'acceptance_failed', turns: loopResult.turns, report: outcome.report };
    }

    const n = (outcome.fixTasks ?? []).length;
    appendFixTasks(cwd, outcome.fixTasks ?? []);
    log(`acceptance found issues — added ${n} fix task(s), re-running…`);
  }
}
