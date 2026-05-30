// task-gen.js — REQ-019 (subtask 4.3)
// Pure core of the verified task-generation path: turn the JSON array that
// `claude -p` emits from a PRD into a task-master tasks.json structure.
//
// The verified path drives the claude CLI directly — NEVER task-master's
// claude-code agent-SDK provider, which hangs past 16 minutes on this host.

/**
 * @param {string} arrayText  raw text from claude (a JSON array, optionally fenced)
 * @param {{description?:string, now?:string}} [opts]  now is injected for determinism
 * @returns tagged tasks.json object: { master: { tasks, metadata } }
 */
export function assembleTasksJson(arrayText, opts = {}) {
  const { description = 'Tasks for the supervisor agent', now = '1970-01-01T00:00:00.000Z' } = opts;

  let text = String(arrayText).trim();
  if (text.startsWith('```')) {
    text = text
      .replace(/^```[a-z]*\r?\n?/i, '')
      .replace(/```$/, '')
      .trim();
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('assembleTasksJson: expected a JSON array of tasks');
  }

  const tasks = parsed.map((t, i) => ({
    id: Number(t.id ?? i + 1),
    title: t.title ?? '',
    description: t.description ?? '',
    details: t.details ?? '',
    testStrategy: t.testStrategy ?? '',
    priority: t.priority ?? 'medium',
    dependencies: (t.dependencies ?? [])
      .map(Number)
      .filter((n) => Number.isFinite(n)),
    status: 'pending',
    subtasks: [],
  }));

  return { master: { tasks, metadata: { created: now, updated: now, description } } };
}
