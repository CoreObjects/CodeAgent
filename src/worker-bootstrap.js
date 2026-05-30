// worker-bootstrap.js — REQ-015
// Concise behavior guidance for the Claude Code worker. States the role, points
// at the task-master trunk, and names the test command — WITHOUT imposing a rigid
// output schema, so the worker keeps its native tool-use loop.

export function buildWorkerBootstrap({ testCommand = null } = {}) {
  const tc = Array.isArray(testCommand) ? testCommand.join(' ') : testCommand || null;
  const lines = [
    'You are the worker (Claude Code). Implement the on-deck task the supervisor relays each turn; tasks originate from the `task-master next` trunk.',
    'Use your native tools to read context, write code, and run commands. Work the task to genuine completion.',
  ];
  if (tc) lines.push(`When verifying changes, run the project test command \`${tc}\` and report the real result.`);
  lines.push(
    'Report what you actually did and changed. Never claim completion the evidence does not support — if something is unfinished or tests fail, say so plainly.',
  );
  return lines.join(' ');
}
