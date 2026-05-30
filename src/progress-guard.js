// progress-guard.js — REQ-016
// A mechanical non-progress guard. It observes each turn's ground truth and
// counts CONSECUTIVE no-progress turns — a turn counts as no-progress only when
// the changed-file list is empty AND the test exit code is unchanged from the
// prior turn. Any file change or test-result change resets the counter.
//
// At the configured threshold it signals exactly one escalation (latched until a
// reset), and does NOTHING else: it never auto-aborts and never judges
// correctness. The loop turns that escalation signal into a human pause via the
// escalation channel (REQ-011). This is one of REQ-008's permitted numeric
// safety branches — pure counting, zero semantic judgment.

export function createProgressGuard({ threshold = 3 } = {}) {
  let count = 0;
  let lastTestExit; // undefined until the first observation
  let escalated = false; // latch so the threshold escalates exactly once per streak

  function observe(groundTruth) {
    const changedCount = groundTruth?.changedFiles?.length ?? 0;
    const testExit = groundTruth?.test?.exit_code ?? null;

    const filesChanged = changedCount > 0;
    const testChanged = lastTestExit !== undefined && testExit !== lastTestExit;
    lastTestExit = testExit;

    if (filesChanged || testChanged) {
      count = 0;
      escalated = false;
    } else {
      count += 1;
    }
    return count;
  }

  function shouldEscalate() {
    if (count >= threshold && !escalated) {
      escalated = true; // latch — no repeat spam while the stall persists
      return true;
    }
    return false;
  }

  function question(taskId) {
    return (
      `No progress on task ${taskId} for ${count} consecutive turns ` +
      `(no file changes, test result unchanged). Continue waiting, redirect, or abort?`
    );
  }

  function reset() {
    count = 0;
    lastTestExit = undefined;
    escalated = false;
  }

  return {
    observe,
    shouldEscalate,
    question,
    reset,
    get count() {
      return count;
    },
  };
}
