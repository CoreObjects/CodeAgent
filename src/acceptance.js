// acceptance.js — Phase 3 (v3)
// Final, whole-project acceptance. After every task is done, codex does a DEEP,
// firsthand review: it explores the repo (read-only sandbox allows reads + test
// runs + git log) and judges the WHOLE project against the PRD acceptance
// criteria, returning accept/reject + findings + fix tasks per the schema.
//
// This is the "deep-review" invocation (the heavy half of "both" — the light
// project map rides every turn; this looks firsthand at milestones/acceptance).
// The orchestrator stays dumb: codex decides accept/reject; we mechanically
// self-heal (add fix tasks, re-loop) up to N rounds, then escalate to the human.

import fs from 'node:fs';
import path from 'node:path';
import { runProcess as defaultRunProcess } from './proc.js';
import { buildCodexExecArgs } from './codex-supervisor.js';

/** The deep-review prompt: explore firsthand, run the suite, judge against the PRD. */
export function buildAcceptancePrompt({ role = '', prdPath, projectMap = '', testCommand = null }) {
  const tc = Array.isArray(testCommand) ? testCommand.join(' ') : testCommand;
  return [
    role,
    '### FINAL ACCEPTANCE REVIEW',
    `Read the PRD at ${prdPath} and its acceptance criteria. You are in a read-only sandbox: READ the source files, inspect git log, and RUN the project test command yourself${tc ? ` (\`${tc}\`)` : ''} to see real results. Do not trust prior summaries — verify firsthand.`,
    projectMap || null,
    'Judge the WHOLE project against the PRD. Return the acceptance object per the JSON schema: accept=true ONLY if every acceptance criterion is met and the suite passes; otherwise accept=false with concrete findings (cite the file/test output) and the fix_tasks the worker must complete to pass. Respond only with the structured object.',
  ]
    .filter((s) => s != null)
    .join('\n\n');
}

/** Defense-in-depth validation of codex's acceptance object. */
export function validateAcceptance(d) {
  if (d == null || typeof d !== 'object') return { ok: false, errors: ['not an object'] };
  const errors = [];
  if (typeof d.accept !== 'boolean') errors.push('accept must be boolean');
  if (typeof d.assessment !== 'string' || !d.assessment) errors.push('missing assessment');
  if (!Array.isArray(d.findings)) errors.push('findings must be an array');
  if (!Array.isArray(d.fix_tasks)) errors.push('fix_tasks must be an array');
  if (typeof d.report !== 'string') errors.push('missing report');
  return { ok: errors.length === 0, errors };
}

/**
 * Mechanical outcome from codex's acceptance decision (pure, no judgment):
 *   accept -> 'accept'; reject within budget -> 'heal' (+fixTasks); else 'escalate'.
 */
export function decideAcceptanceOutcome({ decision, round, maxRounds }) {
  if (decision.accept === true) return { action: 'accept', report: decision.report ?? '' };
  if (round < maxRounds) return { action: 'heal', fixTasks: decision.fix_tasks ?? [], report: decision.report ?? '' };
  return { action: 'escalate', report: decision.report ?? '' };
}

function escalateOnFailure() {
  return {
    decision: {
      accept: false,
      assessment: 'codex did not return a schema-valid acceptance decision',
      findings: [],
      fix_tasks: [],
      report: 'Acceptance review failed to produce a valid decision; escalating.',
    },
    valid: false,
  };
}

/**
 * Run one acceptance review (codex deep-review with the acceptance schema). No
 * stdin evidence — codex gathers its own. Re-asks once on malformed output, else
 * returns a synthetic reject so a human decides. Returns { decision, valid }.
 */
export async function runAcceptance({ runProcess = defaultRunProcess, codexBin, schemaPath, decisionFile, prompt, env, cwd, timeoutMs }) {
  const args = buildCodexExecArgs({ schemaPath, decisionFile });
  const invoke = async (p) => {
    await runProcess(codexBin, [...args, p], { env, cwd, timeoutMs });
    try {
      return JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    } catch {
      return null;
    }
  };

  let parsed = await invoke(prompt);
  let v = validateAcceptance(parsed);
  if (v.ok) return { decision: parsed, valid: true };

  parsed = await invoke(`${prompt}\n\n### RETRY\nYour previous output was invalid (${v.errors.join('; ')}). Return ONLY a JSON object matching the schema.`);
  v = validateAcceptance(parsed);
  if (v.ok) return { decision: parsed, valid: true };

  return escalateOnFailure();
}

/**
 * Self-heal: append codex's fix tasks straight into tasks.json (pending, high
 * priority) so the loop's `task-master next` picks them up. We write the file
 * directly rather than `task-master add-task` — that path is AI-driven and hangs
 * on the claude-code provider on this host. Returns the number added.
 */
export function appendFixTasks(cwd, fixTasks = []) {
  if (!fixTasks.length) return 0;
  const p = path.join(cwd, '.taskmaster', 'tasks', 'tasks.json');
  const tj = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tasks = tj.master?.tasks ?? [];
  const maxId = tasks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0);
  const added = fixTasks.map((ft, i) => ({
    id: maxId + 1 + i,
    title: ft.title ?? 'fix',
    description: ft.description ?? '',
    details: `Acceptance fix: ${ft.description ?? ft.title ?? ''}`,
    testStrategy: '',
    priority: 'high',
    dependencies: [],
    status: 'pending',
    subtasks: [],
  }));
  tj.master.tasks = [...tasks, ...added];
  fs.writeFileSync(p, JSON.stringify(tj, null, 2), 'utf8');
  return added.length;
}

/** On acceptance, have the worker write an accurate README from the PRD + code. */
export async function generateUsageDoc({ runProcess = defaultRunProcess, claudeBin, cwd, env, timeoutMs }) {
  const prompt =
    'Read .taskmaster/docs/prd.md and the project code, then write an accurate README.md at the repo root: ' +
    'what it is, how to install, how to run, and key usage examples. Create or overwrite README.md so it matches the real code. ' +
    'Then commit it.';
  const res = await runProcess(
    claudeBin,
    ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read Write Edit Bash Glob Grep', '--permission-mode', 'acceptEdits'],
    { cwd, env, timeoutMs },
  );
  return { ok: res.code === 0 && !res.error };
}
