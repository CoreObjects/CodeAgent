import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithAcceptance } from '../src/finalize.js';

// Phase 3 orchestration: run the loop, then codex deep-acceptance. accept ->
// usage doc & done; reject -> self-heal (add fix tasks, re-loop) up to N rounds;
// past N -> escalate. All collaborators injected so it's pure to test.

function harness(over = {}) {
  const calls = { usageDoc: 0, escalated: [], fixAdded: [], loops: 0 };
  const base = {
    runLoop: async () => ({ reason: 'done', turns: 3 }),
    reviewProject: async () => ({ decision: { accept: true, report: 'all good', fix_tasks: [] } }),
    appendFixTasks: (cwd, fixTasks) => calls.fixAdded.push(fixTasks),
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

test('reject then accept -> self-heals once, then accepted', async () => {
  let loopN = 0;
  let reviewN = 0;
  const { deps, calls } = harness({
    runLoop: async () => ((loopN += 1), { reason: 'done', turns: loopN }),
    reviewProject: async () =>
      reviewN++ === 0
        ? { decision: { accept: false, report: 'needs fix', fix_tasks: [{ title: 'fix', description: 'd' }] } }
        : { decision: { accept: true, report: 'ok', fix_tasks: [] } },
  });
  const r = await runWithAcceptance(deps);
  assert.equal(r.reason, 'accepted');
  assert.equal(calls.fixAdded.length, 1); // one heal round
  assert.equal(calls.fixAdded[0][0].title, 'fix');
  assert.equal(loopN, 2); // loop ran again after healing
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
