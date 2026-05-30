// codex-supervisor.js — REQ-006
// Invoke codex (the supervisor brain) non-interactively with an enforced output
// schema and a bounded prompt (role + goal + rolling memo); the evidence digest
// is piped via stdin. Read the decision file, validate it, re-ask once on
// malformed output, and otherwise ESCALATE — never guess a verdict.
//
// Verified on this host: `codex exec` blocks reading stdin until EOF (proc.js
// closes it after writing the evidence), read-only blocks file writes, and
// --output-schema returns schema-valid JSON.

import fs from 'node:fs';
import { runProcess as defaultRunProcess } from './proc.js';

const VERDICTS = ['continue', 'redirect', 'task_complete', 'escalate', 'abort'];

/** codex exec argv: read-only sandbox, approval never, json, schema, output file (8.1). */
export function buildCodexExecArgs({ schemaPath, decisionFile }) {
  return [
    'exec',
    '--json',
    '-s',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--skip-git-repo-check',
    '--output-schema',
    schemaPath,
    '-o',
    decisionFile,
  ];
}

/** Bounded prompt: role + goal + rolling memo; evidence arrives via stdin (8.2). */
export function assembleCodexPrompt({ role, goal, memo = '', memoCap = 6000 }) {
  const m = memo.length > memoCap ? memo.slice(0, memoCap) : memo;
  return [
    role,
    '### GOAL',
    goal,
    '### ROLLING MEMO (your own notes from prior turns)',
    m,
    '### THIS TURN',
    'The evidence digest for this turn is in the <stdin> block. Compare the worker CLAIMS against the FACTS and decide a verdict per the JSON schema. Respond only with the structured object.',
  ].join('\n\n');
}

/** Local schema validation (defense-in-depth beyond codex --output-schema) (8.3). */
export function validateDecision(d) {
  if (d == null || typeof d !== 'object') return { ok: false, errors: ['decision is not an object'] };
  const errors = [];
  if (!VERDICTS.includes(d.verdict)) errors.push(`invalid verdict: ${d.verdict}`);
  if (typeof d.assessment !== 'string' || !d.assessment) errors.push('missing assessment');
  if (!Array.isArray(d.cited_evidence) || d.cited_evidence.length < 1) {
    errors.push('cited_evidence must have at least one item');
  }
  if (typeof d.updated_memo !== 'string') errors.push('missing updated_memo');
  if ((d.verdict === 'continue' || d.verdict === 'redirect') && !d.message_to_claude) {
    errors.push('message_to_claude required for continue/redirect');
  }
  if (d.verdict === 'escalate' && !d.escalation_question) {
    errors.push('escalation_question required for escalate');
  }
  return { ok: errors.length === 0, errors };
}

async function invokeOnce(runProcess, codexBin, args, instructions, evidenceJson, decisionFile, opts) {
  await runProcess(codexBin, [...args, instructions], {
    env: opts.env,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    input: evidenceJson, // evidence via stdin; proc.js closes stdin so codex does not hang
  });
  try {
    return JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
  } catch {
    return null; // missing or malformed decision file
  }
}

function escalateOnFailure(reAsked) {
  return {
    decision: {
      assessment: 'codex did not return a schema-valid decision after a retry',
      verdict: 'escalate',
      escalation_question:
        'The supervisor could not produce a valid decision this turn. How should we proceed — retry, skip the turn, or abort?',
      escalation_category: 'judgment_human_would_want',
      cited_evidence: [{ source: 'tool_result', observation: 'codex output failed schema validation twice' }],
      updated_memo: '',
    },
    valid: false,
    reAsked,
  };
}

/**
 * Run one supervisor turn (8.3, 8.4). Returns { decision, valid, reAsked }.
 * On a malformed decision it re-asks exactly once; if still invalid it escalates
 * to the human rather than guessing a verdict.
 */
export async function runCodexSupervisor({
  runProcess = defaultRunProcess,
  codexBin,
  schemaPath,
  decisionFile,
  instructions,
  evidenceJson,
  env,
  cwd,
  timeoutMs,
}) {
  const args = buildCodexExecArgs({ schemaPath, decisionFile });
  const opts = { env, cwd, timeoutMs };

  let parsed = await invokeOnce(runProcess, codexBin, args, instructions, evidenceJson, decisionFile, opts);
  let v = validateDecision(parsed);
  if (v.ok) return { decision: parsed, valid: true, reAsked: false };

  const retry = `${instructions}\n\n### RETRY\nYour previous output was not a valid decision (${v.errors.join('; ')}). Return ONLY a JSON object matching the schema.`;
  parsed = await invokeOnce(runProcess, codexBin, args, retry, evidenceJson, decisionFile, opts);
  v = validateDecision(parsed);
  if (v.ok) return { decision: parsed, valid: true, reAsked: true };

  return escalateOnFailure(true);
}
