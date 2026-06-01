import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanReviewCycle } from '../src/plan-review.js';

// Pure orchestration: plan mode claude → codex reviews the plan → returns execute instruction.
// All collaborators injected so it's fully testable without real CLIs.

function harness({ planTexts = ['my plan'], reviewResults = [{ accepted: true, assessment: 'good', feedback: '' }] } = {}) {
  const calls = { plan: [], review: [] };
  let pi = 0;
  let ri = 0;
  const next = (arr, i, dflt) => (i < arr.length ? arr[i] : dflt);
  return {
    runPlanTurn: async (instruction) => {
      calls.plan.push(instruction);
      return { finalText: next(planTexts, pi++, '') };
    },
    reviewPlan: async ({ fixRequirements, planText }) => {
      calls.review.push({ fixRequirements, planText });
      return next(reviewResults, ri++, { accepted: false, assessment: 'bad', feedback: 'still wrong' });
    },
    calls,
  };
}

test('plan accepted on first round: returns an execute instruction containing the plan', async () => {
  const { runPlanTurn, reviewPlan, calls } = harness({
    planTexts: ['Step 1: fix engine.py\nStep 2: update tests'],
    reviewResults: [{ accepted: true, assessment: 'solid', feedback: '' }],
  });
  const instruction = await runPlanReviewCycle({ runPlanTurn, reviewPlan, fixRequirements: 'fix the sum mock' });
  assert.equal(calls.plan.length, 1);
  assert.equal(calls.review.length, 1);
  assert.match(instruction, /execute/i);
  assert.match(instruction, /Step 1: fix engine\.py/);
});

test('plan rejected on first round, accepted on second: returns the second plan as execute instruction', async () => {
  const { runPlanTurn, reviewPlan, calls } = harness({
    planTexts: ['bad plan', 'good plan v2'],
    reviewResults: [
      { accepted: false, assessment: 'incomplete', feedback: 'missing test update' },
      { accepted: true, assessment: 'complete', feedback: '' },
    ],
  });
  const instruction = await runPlanReviewCycle({ runPlanTurn, reviewPlan, fixRequirements: 'fix sum', maxRounds: 2 });
  assert.equal(calls.plan.length, 2);
  assert.equal(calls.review.length, 2);
  assert.match(instruction, /good plan v2/);
  // second plan instruction should include the first rejection feedback
  assert.match(calls.plan[1], /missing test update/);
});

test('plan rejected for all rounds: force-passes the last plan (never discards the plan)', async () => {
  const { runPlanTurn, reviewPlan } = harness({
    planTexts: ['plan1', 'plan2 — final attempt'],
    reviewResults: [
      { accepted: false, assessment: 'bad', feedback: 'wrong approach' },
      { accepted: false, assessment: 'bad', feedback: 'still wrong' },
    ],
  });
  const instruction = await runPlanReviewCycle({ runPlanTurn, reviewPlan, fixRequirements: 'fix sum', maxRounds: 2 });
  // must contain the last plan text
  assert.match(instruction, /plan2 — final attempt/);
  // must be an execute instruction (not just raw requirements)
  assert.match(instruction, /[Ee]xecute/);
});
