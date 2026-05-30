import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCodexExecArgs,
  assembleCodexPrompt,
  validateDecision,
  runCodexSupervisor,
} from '../src/codex-supervisor.js';

// REQ-006: codex supervisor invocation with an enforced decision schema.

const VALID = {
  assessment: 'no diff but worker claimed done',
  verdict: 'redirect',
  message_to_claude: 'actually implement it and run the tests',
  cited_evidence: [{ source: 'git_diff', observation: 'changedFiles is empty' }],
  fake_done_flag: true,
  updated_memo: 'task still open',
};

// --- 8.1 arg builder ------------------------------------------------------

test('codex exec args: read-only sandbox, approval never, json, output-schema, -o', () => {
  const a = buildCodexExecArgs({ schemaPath: 's.json', decisionFile: 'd.json' });
  assert.equal(a[0], 'exec');
  assert.ok(a.includes('--json'));
  const si = a.indexOf('-s');
  assert.equal(a[si + 1], 'read-only');
  assert.ok(a.some((x) => /approval_policy="?never"?/.test(x)));
  assert.equal(a[a.indexOf('--output-schema') + 1], 's.json');
  assert.equal(a[a.indexOf('-o') + 1], 'd.json');
});

// --- 8.2 bounded prompt ---------------------------------------------------

test('assembleCodexPrompt includes role, goal and memo under fixed delimiters', () => {
  const p = assembleCodexPrompt({ role: 'ROLE', goal: 'GOAL', memo: 'MEMO' });
  assert.match(p, /ROLE/);
  assert.match(p, /GOAL/);
  assert.match(p, /MEMO/);
  assert.match(p, /stdin/i); // evidence delivered via stdin
});

// --- 8.3 decision validation ----------------------------------------------

test('validateDecision accepts a well-formed decision', () => {
  assert.equal(validateDecision(VALID).ok, true);
});

test('validateDecision rejects an unknown verdict', () => {
  assert.equal(validateDecision({ ...VALID, verdict: 'bogus' }).ok, false);
});

test('validateDecision rejects empty cited_evidence (minItems 1)', () => {
  assert.equal(validateDecision({ ...VALID, cited_evidence: [] }).ok, false);
});

test('validateDecision requires message_to_claude for continue/redirect', () => {
  const { message_to_claude, ...noMsg } = VALID;
  assert.equal(validateDecision(noMsg).ok, false);
});

test('validateDecision requires escalation_question when verdict is escalate', () => {
  const d = { ...VALID, verdict: 'escalate', message_to_claude: undefined };
  assert.equal(validateDecision(d).ok, false);
});

// --- 8.3 / 8.4 read decision file + re-ask + escalate ---------------------

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('runCodexSupervisor runs codex, reads the -o decision file, and validates it', async () => {
  await withTmp(async (dir) => {
    const decisionFile = path.join(dir, 'd.json');
    const schemaPath = path.join(dir, 's.json');
    fs.writeFileSync(schemaPath, '{}');
    const runProcess = async (bin, args) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(VALID));
      return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    };
    const r = await runCodexSupervisor({
      runProcess,
      codexBin: 'codex',
      schemaPath,
      decisionFile,
      instructions: 'decide',
      evidenceJson: '{}',
    });
    assert.equal(r.valid, true);
    assert.equal(r.decision.verdict, 'redirect');
    assert.equal(r.reAsked, false);
  });
});

test('runCodexSupervisor re-asks once on malformed output, then escalates', async () => {
  await withTmp(async (dir) => {
    const decisionFile = path.join(dir, 'd.json');
    const schemaPath = path.join(dir, 's.json');
    fs.writeFileSync(schemaPath, '{}');
    let calls = 0;
    const runProcess = async (bin, args) => {
      calls += 1;
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'this is not json');
      return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    };
    const r = await runCodexSupervisor({
      runProcess,
      codexBin: 'codex',
      schemaPath,
      decisionFile,
      instructions: 'decide',
      evidenceJson: '{}',
    });
    assert.equal(calls, 2, 'expected original call + one re-ask');
    assert.equal(r.reAsked, true);
    assert.equal(r.decision.verdict, 'escalate'); // never guesses a verdict
  });
});

test('runCodexSupervisor delivers the evidence via stdin (input), not as an arg', async () => {
  await withTmp(async (dir) => {
    const decisionFile = path.join(dir, 'd.json');
    const schemaPath = path.join(dir, 's.json');
    fs.writeFileSync(schemaPath, '{}');
    let capturedInput;
    const runProcess = async (bin, args, opts) => {
      capturedInput = opts?.input;
      fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(VALID));
      return { code: 0, stdout: '', stderr: '', timedOut: false, error: null };
    };
    await runCodexSupervisor({
      runProcess,
      codexBin: 'codex',
      schemaPath,
      decisionFile,
      instructions: 'decide',
      evidenceJson: '{"digest":true}',
    });
    assert.equal(capturedInput, '{"digest":true}');
  });
});
