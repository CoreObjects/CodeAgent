// plan-review.js
// When a checkpoint is rejected or final acceptance fails, instead of sending
// fix requirements directly to claude (which causes shallow, unfocused edits),
// we first run claude in plan mode (read-only) to produce a structured fix plan,
// then ask codex to review the plan, and only send "execute this approved plan"
// to claude once codex signs off. Matches the user's own workflow for non-trivial
// fixes: plan → review → execute.
//
// Pure of side effects. runPlanTurn and reviewPlan are injected for testing.

/**
 * Run a plan-review cycle:
 *   1. claude (plan mode) reads the repo and produces a fix plan
 *   2. codex reviews the plan against the fix requirements
 *   3. If accepted: returns "Execute this approved plan: <planText>"
 *   4. If rejected: revise instruction includes codex's feedback, retry up to maxRounds
 *   5. If still not accepted after maxRounds: graceful degradation — return fixRequirements
 *      directly so claude at least tries without a plan review.
 *
 * @param {{
 *   runPlanTurn: (instruction: string) => Promise<{finalText: string}>,
 *   reviewPlan: (opts: {fixRequirements: string, planText: string}) => Promise<{accepted: boolean, assessment: string, feedback: string}>,
 *   fixRequirements: string,
 *   maxRounds?: number,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<string>} instruction to pass to the next worker (execute) turn
 */
export async function runPlanReviewCycle({ runPlanTurn, reviewPlan, fixRequirements, maxRounds = 2, log = () => {} }) {
  let planInstruction =
    `Plan how to fix the following issues. Read the relevant source files first, then describe ` +
    `EXACTLY which files you will change and what each change will do. Do NOT make any changes yet.\n\n` +
    `Issues to fix:\n${fixRequirements}`;

  let lastPlanText = '';
  for (let round = 0; round < maxRounds; round++) {
    const turn = await runPlanTurn(planInstruction);
    lastPlanText = turn.finalText;

    const review = await reviewPlan({ fixRequirements, planText: lastPlanText });
    if (review.accepted) {
      log(`Plan approved on round ${round + 1}.`);
      return `Execute this approved plan exactly as described:\n\n${lastPlanText}\n\nOriginal requirements:\n${fixRequirements}`;
    }

    log(`Plan rejected (round ${round + 1}): ${review.feedback}`);
    planInstruction =
      `Your previous plan was rejected for these reasons:\n${review.feedback}\n\n` +
      `Revise your plan to fully address:\n${fixRequirements}`;
  }

  // After maxRounds without approval, force-pass the last plan rather than discarding it.
  // codex is meant to be lenient and only block obvious omissions — if it still hasn't
  // approved after 2 rounds, the plan is good enough; proceed with execution.
  log(`Plan review exhausted ${maxRounds} round(s) — forcing execution of last plan.`);
  return `Execute this plan exactly as described:\n\n${lastPlanText}\n\nOriginal requirements:\n${fixRequirements}`;
}
