// evidence-digest.js — REQ-005
// Merge the normalized worker turn (CLAIMS) with ground truth (FACTS) into one
// bounded digest whose claims and facts blocks are DISTINCT fields, so codex can
// detect a fake "done" by direct comparison. divergence_hints are mechanical data
// only — no code path may use them to alter routing (enforced by the router, REQ-007).

const DEFAULT_CAPS = { text: 1500, porcelain: 1500, testTail: 800, array: 25, taskText: 800, title: 200 };
const TOTAL_CAP = 6000;

function capStr(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, Math.max(0, n - 1))}…` : str;
}

function capArr(a, n) {
  const arr = a ?? [];
  return arr.length <= n ? arr.slice() : [...arr.slice(0, n), `…+${arr.length - n} more`];
}

/** CLAIMS: what the worker said and did (subtask 7.1). No interpretation. */
export function buildClaimsBlock(turn) {
  const resById = new Map((turn.toolResults ?? []).map((r) => [r.toolUseId, r]));
  const actionsTaken = (turn.toolUseCalls ?? []).map((tu) => ({
    name: tu.name,
    isError: resById.get(tu.id)?.isError === true,
  }));
  return {
    finalText: turn.finalText ?? '',
    resultSubtype: turn.resultEvent?.subtype ?? null,
    numTurns: turn.resultEvent?.num_turns ?? null,
    toolUseCount: (turn.toolUseCalls ?? []).length,
    actionsTaken,
  };
}

/** FACTS: what the orchestrator observed (subtask 7.2). Distinct from claims. */
export function buildFactsBlock(gt) {
  return {
    headBefore: gt.headBefore ?? null,
    headAfter: gt.headAfter ?? null,
    committed: gt.committed === true,
    diffStat: gt.diffStat ?? { filesChanged: 0, insertions: 0, deletions: 0 },
    changedFiles: gt.changedFiles ?? [],
    porcelain: gt.porcelain ?? '',
    test: gt.test
      ? { ran: gt.test.ran === true, exitCode: gt.test.exitCode ?? null, outputTail: gt.test.outputTail ?? '' }
      : null,
  };
}

/** Mechanical divergence flags (subtask 7.4) — DATA ONLY, never routing input. */
export function computeDivergenceHints(claims, facts) {
  const finalText = claims.finalText ?? '';
  const doneish = /\b(done|complete|completed|finished|all tests? pass|ready)\b/i.test(finalText);
  const mentionsTests = /\btests?\b/i.test(finalText);
  const noDiff = (facts.changedFiles?.length ?? 0) === 0;
  return {
    claimedDoneButNoDiff: doneish && noDiff,
    testsReferencedButNotRun: mentionsTests && (!facts.test || facts.test.ran !== true),
    toolErrorsPresent: (claims.actionsTaken ?? []).some((a) => a.isError),
  };
}

function boundDigest(base, caps) {
  return {
    turn: base.turn,
    task: base.task
      ? { id: base.task.id, title: capStr(base.task.title, caps.title), acceptance: capStr(base.task.acceptance, caps.taskText) }
      : null,
    claims: {
      ...base.claims,
      finalText: capStr(base.claims.finalText, caps.text),
      actionsTaken: capArr(base.claims.actionsTaken, caps.array),
    },
    facts: {
      ...base.facts,
      changedFiles: capArr(base.facts.changedFiles, caps.array),
      porcelain: capStr(base.facts.porcelain, caps.porcelain),
      test: base.facts.test ? { ...base.facts.test, outputTail: capStr(base.facts.test.outputTail, caps.testTail) } : null,
    },
    divergence_hints: base.divergence_hints,
  };
}

/**
 * Build the bounded digest and serialize it (subtasks 7.3, 7.5). If the JSON
 * exceeds the total cap, re-bound with progressively tighter sub-caps until it
 * fits. Returns { digest, json, bytes }; never ships an over-cap digest.
 */
export function buildEvidenceDigest({ turn, groundTruth, task, turnIndex = 0 }, { totalCap = TOTAL_CAP } = {}) {
  const claims = buildClaimsBlock(turn);
  const facts = buildFactsBlock(groundTruth);
  const base = { turn: turnIndex, task: task ?? null, claims, facts, divergence_hints: computeDivergenceHints(claims, facts) };

  let caps = { ...DEFAULT_CAPS };
  let digest = boundDigest(base, caps);
  let json = JSON.stringify(digest);
  for (let guard = 0; json.length > totalCap && guard < 10; guard++) {
    caps = {
      text: Math.max(120, Math.floor(caps.text * 0.6)),
      porcelain: Math.max(120, Math.floor(caps.porcelain * 0.6)),
      testTail: Math.max(80, Math.floor(caps.testTail * 0.6)),
      array: Math.max(5, Math.floor(caps.array * 0.6)),
      taskText: Math.max(120, Math.floor(caps.taskText * 0.6)),
      title: caps.title,
    };
    digest = boundDigest(base, caps);
    json = JSON.stringify(digest);
  }
  return { digest, json, bytes: json.length };
}
