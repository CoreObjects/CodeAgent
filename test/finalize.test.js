import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithAcceptance } from '../src/finalize.js';

// Phase 3 orchestration: run the loop, then codex deep-acceptance. accept ->
// usage doc & done; reject -> self-heal (add fix tasks, re-loop) up to N rounds;
// past N -> escalate. All collaborators injected so it's pure to test.

function harness(over = {}) {
  const calls = { usageDoc: 0, escalated: [], loopCount: 0, healInstructions: [] };
  const base = {
    runLoop: async (healInstruction) => {
      calls.loopCount++;
      calls.healInstructions.push(healInstruction);
      return { reason: 'done', turns: calls.loopCount };
    },
    reviewProject: async () => ({ decision: { accept: true, report: 'all good', fix_tasks: [] } }),
    writeUsageDoc: async () => calls.usageDoc++,
    askHuman: async (q) => calls.escalated.push(q),
    cwd: '/x',
    maxRounds: 2,
  };
  return { deps: { ...base, ...over }, calls };
}

test('accept -> writes the usage doc and returns accepted', async () => {
  const { deps, calls } = harness();
  const r = await runWithAcceptance(deps);
  assert.equal(r.reason, 'accepted');
  assert.equal(calls.usageDoc, 1);
  assert.equal(calls.escalated.length, 0);
});

test('reject then accept -> self-heals once: relays fix instructions to the next loop (not tasks.json)', async () => {
  let reviewN = 0;
  const { deps, calls } = harness({
    reviewProject: async () =>
      reviewN++ === 0
        ? { decision: { accept: false, report: 'needs fix', fix_tasks: [{ title: 'fix', description: 'd' }] } }
        : { decision: { accept: true, report: 'ok', fix_tasks: [] } },
  });
  const r = await runWithAcceptance(deps);
  assert.equal(r.reason, 'accepted');
  assert.equal(calls.loopCount, 2); // loop ran again after healing
  // second loop call received a heal instruction (not tasks.json write)
  assert.equal(typeof calls.healInstructions[1], 'string');
  assert.match(calls.healInstructions[1], /fix/);
  assert.equal(calls.usageDoc, 1);
});

test('persistent reject past the round budget -> escalates with the report, no usage doc', async () => {
  const { deps, calls } = harness({
    maxRounds: 1,
    reviewProject: async () => ({ decision: { accept: false, report: 'still broken', fix_tasks: [{ title: 't', description: 'd' }] } }),
  });
  const r = await runWithAcceptance(deps);
  assert.equal(r.reason, 'acceptance_failed');
  assert.equal(calls.usageDoc, 0);
  assert.equal(calls.escalated.length, 1);
  assert.match(calls.escalated[0], /still broken/);
});

test('a loop that aborts is returned as-is (no acceptance)', async () => {
  const { deps, calls } = harness({ runLoop: async () => ({ reason: 'abort', turns: 1 }) });
  const r = await runWithAcceptance(deps);
  assert.equal(r.reason, 'abort');
  assert.equal(calls.usageDoc, 0);
});
