// ground-truth.js — REQ-004
// The orchestrator's OWN eyes: observe repository state independently of what the
// worker claims. Snapshot HEAD + porcelain before the turn; after the turn report
// diff stats, the changed-file list scoped to the pre-turn HEAD, porcelain status,
// and (if configured) the test command's exit code + output tail.
//
// Emits only observed values — NO interpretation. Divergence judgment belongs to
// the digest (REQ-005) and codex. All shell-outs route through proc.js (REQ-001).

import { runProcess as defaultRunProcess } from './proc.js';

/** Parse `git diff --shortstat` output into counts (pure). */
export function parseShortstat(text) {
  const t = String(text);
  const files = /(\d+) files? changed/.exec(t);
  const ins = /(\d+) insertions?\(\+\)/.exec(t);
  const del = /(\d+) deletions?\(-\)/.exec(t);
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  };
}

/** Snapshot HEAD and porcelain status BEFORE the worker turn (subtask 6.1). */
export async function snapshotStart({ runProcess = defaultRunProcess, cwd }) {
  const [head, status] = await Promise.all([
    runProcess('git', ['rev-parse', 'HEAD'], { cwd }),
    runProcess('git', ['status', '--porcelain'], { cwd }),
  ]);
  return { head: (head.stdout ?? '').trim(), porcelain: status.stdout ?? '' };
}

function normalizeTestCommand(tc) {
  if (!tc) return null;
  if (Array.isArray(tc)) return tc.length ? tc : null;
  const parts = String(tc).trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts : null;
}

function tail(text, n) {
  const s = String(text);
  return s.length > n ? s.slice(-n) : s;
}

/**
 * Collect ground truth AFTER the turn (subtasks 6.2-6.4): diff stats and the
 * changed-file list scoped to the pre-turn HEAD, current porcelain, and the
 * optional test command result. When no test command is configured the `test`
 * field is omitted entirely (never a fabricated pass).
 */
export async function collect({ runProcess = defaultRunProcess, cwd, snapshot, testCommand = null }) {
  const preHead = snapshot.head;
  const [shortstat, nameOnly, status, headAfter] = await Promise.all([
    runProcess('git', ['diff', '--shortstat', preHead], { cwd }),
    runProcess('git', ['diff', '--name-only', preHead], { cwd }),
    runProcess('git', ['status', '--porcelain'], { cwd }),
    runProcess('git', ['rev-parse', 'HEAD'], { cwd }),
  ]);

  const after = (headAfter.stdout ?? '').trim();
  const result = {
    headBefore: preHead,
    headAfter: after,
    committed: after !== preHead,
    diffStat: parseShortstat(shortstat.stdout),
    changedFiles: (nameOnly.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    porcelain: status.stdout ?? '',
  };

  const tc = normalizeTestCommand(testCommand);
  if (tc) {
    const tr = await runProcess(tc[0], tc.slice(1), { cwd });
    result.test = {
      ran: true,
      command: tc.join(' '),
      exitCode: tr.code,
      timedOut: tr.timedOut === true,
      outputTail: tail((tr.stdout ?? '') + (tr.stderr ?? ''), 800),
    };
  }
  return result;
}
