import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaimsBlock,
  buildFactsBlock,
  computeDivergenceHints,
  buildEvidenceDigest,
} from '../src/evidence-digest.js';

// REQ-005: bounded evidence digest separating CLAIMS from FACTS.

const turn = {
  finalText: 'All done, tests pass.',
  resultEvent: { subtype: 'success', num_turns: 2 },
  toolUseCalls: [
    { id: 'a', name: 'Edit', input: {} },
    { id: 'b', name: 'Bash', input: {} },
  ],
  toolResults: [
    { toolUseId: 'a', isError: false },
    { toolUseId: 'b', isError: true },
  ],
};

const gtChanged = {
  headBefore: 'aaa',
  headAfter: 'bbb',
  committed: true,
  diffStat: { filesChanged: 1, insertions: 3, deletions: 0 },
  changedFiles: ['lib/math.js'],
  porcelain: '',
  test: { ran: true, exitCode: 0, outputTail: 'ok' },
};

const gtFakeDone = {
  headBefore: 'aaa',
  headAfter: 'aaa',
  committed: false,
  diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
  changedFiles: [],
  porcelain: '',
  test: { ran: true, exitCode: 1, outputTail: 'FAIL' },
};

// --- 7.1 / 7.2 blocks -----------------------------------------------------

test('claims block maps final text, counts, and per-call error flags', () => {
  const c = buildClaimsBlock(turn);
  assert.equal(c.finalText, 'All done, tests pass.');
  assert.equal(c.toolUseCount, 2);
  assert.deepEqual(c.actionsTaken, [
    { name: 'Edit', isError: false },
    { name: 'Bash', isError: true },
  ]);
});

test('facts block mirrors ground truth and keeps test null when absent', () => {
  const f = buildFactsBlock({ ...gtChanged, test: undefined });
  assert.deepEqual(f.changedFiles, ['lib/math.js']);
  assert.equal(f.test, null);
});

// --- 7.4 divergence hints (data only) ------------------------------------

test('claimedDoneButNoDiff fires when worker says done but nothing changed', () => {
  const c = buildClaimsBlock(turn);
  const h = computeDivergenceHints(c, buildFactsBlock(gtFakeDone));
  assert.equal(h.claimedDoneButNoDiff, true);
});

test('claimedDoneButNoDiff is false when there is a real diff', () => {
  const c = buildClaimsBlock(turn);
  const h = computeDivergenceHints(c, buildFactsBlock(gtChanged));
  assert.equal(h.claimedDoneButNoDiff, false);
});

test('toolErrorsPresent reflects a per-call error flag', () => {
  const h = computeDivergenceHints(buildClaimsBlock(turn), buildFactsBlock(gtChanged));
  assert.equal(h.toolErrorsPresent, true);
});

test('computeDivergenceHints is pure/deterministic (data only)', () => {
  const c = buildClaimsBlock(turn);
  const f = buildFactsBlock(gtFakeDone);
  assert.deepEqual(computeDivergenceHints(c, f), computeDivergenceHints(c, f));
});

// --- 7.3 / 7.5 bounding + serialization ----------------------------------

test('buildEvidenceDigest keeps the serialized digest at most 6000 chars', () => {
  const huge = {
    finalText: 'x'.repeat(100_000) + ' done',
    resultEvent: { subtype: 'success' },
    toolUseCalls: Array.from({ length: 500 }, (_, i) => ({ id: String(i), name: 'Edit' })),
    toolResults: [],
  };
  const hugeGt = {
    headBefore: 'a',
    headAfter: 'a',
    committed: false,
    diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
    changedFiles: Array.from({ length: 1000 }, (_, i) => `file-${i}.js`),
    porcelain: 'M '.repeat(50_000),
    test: { ran: true, exitCode: 1, outputTail: 'y'.repeat(50_000) },
  };
  const out = buildEvidenceDigest({ turn: huge, groundTruth: hugeGt, task: { id: 1, title: 'T', acceptance: 'A' } });
  assert.ok(out.bytes <= 6000, `digest too large: ${out.bytes}`);
  assert.equal(out.json.length, out.bytes);
});

test('bounding caps an overflowing changed-file array with a sentinel', () => {
  const out = buildEvidenceDigest({
    turn,
    groundTruth: { ...gtChanged, changedFiles: Array.from({ length: 100 }, (_, i) => `f${i}`) },
    task: { id: 1, title: 'T', acceptance: 'A' },
  });
  const cf = out.digest.facts.changedFiles;
  assert.ok(cf[cf.length - 1].includes('more'), 'expected an overflow sentinel');
});

test('digest keeps claims and facts as distinct top-level fields', () => {
  const out = buildEvidenceDigest({ turn, groundTruth: gtChanged, task: { id: 1, title: 'T', acceptance: 'A' } });
  assert.ok('claims' in out.digest && 'facts' in out.digest && 'divergence_hints' in out.digest);
  assert.notEqual(out.digest.claims, out.digest.facts);
});
