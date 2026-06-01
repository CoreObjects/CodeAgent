import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAcceptancePrompt, validateAcceptance, decideAcceptanceOutcome, runAcceptance, appendFixTasks, generateUsageDoc } from '../src/acceptance.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SCHEMA = path.join(ROOT, 'schema', 'acceptance.schema.json');

// Phase 3: after every task is done, codex deep-reviews the WHOLE project against
// the PRD (it explores the repo + runs the suite itself), then accept/reject. On
// reject the loop self-heals (fix tasks) up to N rounds, then escalates.

test('buildAcceptancePrompt instructs a deep, firsthand review against the PRD and tests', () => {
  const p = buildAcceptancePrompt({ prdPath: '.taskmaster/docs/prd.md', projectMap: '### PROJECT MAP\nsrc/ (3)', testCommand: 'npm test' });
  assert.match(p, /prd\.md/);
  assert.match(p, /read|explore/i); // explore the repo itself
  assert.match(p, /npm test/); // run the suite
  assert.match(p, /accept/i);
  assert.match(p, /PROJECT MAP/); // map embedded
});

test('validateAcceptance requires the core fields', () => {
  assert.equal(validateAcceptance({ accept: true, assessment: 'ok', findings: [], fix_tasks: [], report: 'all good' }).ok, true);
  assert.equal(validateAcceptance({ accept: 'yes' }).ok, false);
  assert.equal(validateAcceptance(null).ok, false);
});

test('decideAcceptanceOutcome: accept -> accept', () => {
  const o = decideAcceptanceOutcome({ decision: { accept: true, report: 'R', fix_tasks: [] }, round: 0, maxRounds: 2 });
  assert.equal(o.action, 'accept');
});

test('decideAcceptanceOutcome: reject within budget -> heal with the fix tasks', () => {
  const o = decideAcceptanceOutcome({ decision: { accept: false, report: 'R', fix_tasks: [{ title: 'fix x', description: 'do it' }] }, round: 0, maxRounds: 2 });
  assert.equal(o.action, 'heal');
  assert.equal(o.fixTasks.length, 1);
});

test('decideAcceptanceOutcome: reject past the round budget -> escalate', () => {
  const o = decideAcceptanceOutcome({ decision: { accept: false, report: 'still broken', fix_tasks: [] }, round: 2, maxRounds: 2 });
  assert.equal(o.action, 'escalate');
  assert.match(o.report, /still broken/);
});

test('runAcceptance invokes codex with the acceptance schema and returns the validated decision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-'));
  try {
    const decisionFile = path.join(dir, 'acceptance.json');
    const runProcess = async (bin, args) => {
      assert.equal(args[0], 'exec');
      assert.equal(args[args.indexOf('--output-schema') + 1], SCHEMA);
      const o = args.indexOf('-o');
      fs.writeFileSync(args[o + 1], JSON.stringify({ accept: false, assessment: 'missing tests', findings: [{ severity: 'blocker', detail: 'no tests', evidence: 'pytest: 0 collected' }], fix_tasks: [{ title: 'add tests', description: 'cover REQ-003' }], report: 'rejected: no tests' }));
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const r = await runAcceptance({ runProcess, codexBin: 'CODEX', schemaPath: SCHEMA, decisionFile, prompt: 'review', env: {}, cwd: dir });
    assert.equal(r.decision.accept, false);
    assert.equal(r.decision.fix_tasks[0].title, 'add tests');
    assert.equal(r.valid, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendFixTasks adds pending tasks with fresh ids into tasks.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-'));
  try {
    const p = path.join(dir, '.taskmaster', 'tasks', 'tasks.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ master: { tasks: [{ id: 1, status: 'done' }, { id: 2, status: 'done' }] } }));
    const n = appendFixTasks(dir, [{ title: 'fix A', description: 'do A' }, { title: 'fix B', description: 'do B' }]);
    assert.equal(n, 2);
    const tj = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(tj.master.tasks.length, 4);
    assert.equal(tj.master.tasks[2].id, 3);
    assert.equal(tj.master.tasks[2].status, 'pending');
    assert.equal(tj.master.tasks[3].title, 'fix B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateUsageDoc drives claude with Write allowed to author the README', async () => {
  let seen = null;
  const runProcess = async (bin, args) => {
    seen = { bin, args };
    return { code: 0, stdout: '{}', stderr: '', error: null };
  };
  const r = await generateUsageDoc({ runProcess, claudeBin: 'C', cwd: '/x', env: {} });
  assert.equal(r.ok, true);
  assert.match(seen.args[seen.args.indexOf('-p') + 1], /README/);
  assert.ok(seen.args.includes('--allowedTools') && /Write/.test(seen.args[seen.args.indexOf('--allowedTools') + 1]));
});
