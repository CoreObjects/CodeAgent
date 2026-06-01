// finalize.js — Phase 3 orchestration (v3)
// Wrap the per-task loop with whole-project acceptance: run the loop to
// completion, then codex deep-reviews the project. accept -> usage doc + done;
// reject -> self-heal (relay fix instructions to worker, re-loop) up to maxRounds;
// past that -> escalate to the human with codex's report.
//
// codex is a read-only EXAMINER — it never writes files. On a heal round we pass
// codex's findings as a text instruction to the next runLoop call instead of
// writing fix tasks into tasks.json.
//
// Pure orchestration with every collaborator injected (mirrors loop.js): the
// judgment is codex's (reviewProject); this only mechanically routes the outcome.

import { decideAcceptanceOutcome } from './acceptance.js';

/**
 * @param {{
 *   runLoop: (healInstruction?: string) => Promise<{reason:string,turns?:number}>,
 *   reviewProject: () => Promise<{decision:object}>,
 *   writeUsageDoc: () => Promise<any>,
 *   askHuman: (q:string) => Promise<any>,
 *   cwd?: string,
 *   maxRounds?: number,
 *   log?: (m:string)=>void,
 *   decideOutcome?: typeof decideAcceptanceOutcome,
 * }} deps
 */
export async function runWithAcceptance({
  runLoop,
  reviewProject,
  writeUsageDoc,
  askHuman,
  cwd, // kept for API compat; no longer used (codex never writes files)
  maxRounds = 2,
  log = () => {},
  decideOutcome = decideAcceptanceOutcome,
}) {
  let healInstruction;
  for (let round = 0; ; round++) {
    const loopResult = await runLoop(healInstruction);
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

    // heal: relay codex's findings as a text instruction to the worker — codex never writes files
    const fixes = (outcome.fixTasks ?? []).map((f, i) => `${i + 1}. ${f.title}: ${f.description}`).join('\n');
    healInstruction = `Final acceptance review found issues that must be fixed:\n${outcome.report}\n\nRequired fixes:\n${fixes}`;
    log(`acceptance found issues — relaying ${(outcome.fixTasks ?? []).length} fix(es) to worker, re-running…`);
  }
}
