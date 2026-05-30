import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets, createRunLogger } from '../src/logging.js';

// REQ-013: per-turn transcript logging + token-shape redaction.

test('redactSecrets scrubs Anthropic, OpenAI, and Bearer-shaped tokens', () => {
  const s = redactSecrets('a sk-ant-oat01-abcDEF123456 b sk-proj-ABCdef1234567890XYZ c Bearer abcdef0123456789');
  assert.doesNotMatch(s, /sk-ant-oat01-abcDEF123456/);
  assert.doesNotMatch(s, /sk-proj-ABCdef1234567890XYZ/);
  assert.doesNotMatch(s, /Bearer abcdef0123456789/);
  assert.match(s, /\[REDACTED\]/);
});

test('redactSecrets leaves ordinary text untouched', () => {
  assert.equal(redactSecrets('just a normal sentence with task-master'), 'just a normal sentence with task-master');
});

test('logTurn writes per-turn artifacts and a transcript summary, with redaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  try {
    const logger = createRunLogger({ baseDir: dir, runId: 'run1' });
    logger.logTurn({
      turnIndex: 1,
      workerStream: [{ type: 'system' }, { type: 'result' }],
      groundTruth: { changedFiles: ['x.js'] },
      evidenceDigest: { claims: {}, facts: {} },
      codexPrompt: 'role... token sk-ant-oat01-SECRETVALUE12345 here',
      codexDecision: { verdict: 'redirect', message_to_claude: 'fix it', updated_memo: 'm' },
    });
    const turnDir = path.join(dir, 'run1', 'turn-0001');
    assert.ok(fs.existsSync(path.join(turnDir, 'worker_stream.jsonl')));
    assert.ok(fs.existsSync(path.join(turnDir, 'ground_truth.json')));
    assert.ok(fs.existsSync(path.join(turnDir, 'evidence_digest.json')));
    assert.ok(fs.existsSync(path.join(turnDir, 'codex_decision.json')));
    // redaction applied to the codex prompt file
    const prompt = fs.readFileSync(path.join(turnDir, 'codex_prompt.txt'), 'utf8');
    assert.doesNotMatch(prompt, /SECRETVALUE12345/);
    // human-readable transcript exists and mentions the verdict
    const transcript = fs.readFileSync(path.join(dir, 'run1', 'transcript.md'), 'utf8');
    assert.match(transcript, /Turn 1/);
    assert.match(transcript, /redirect/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker_stream.jsonl is written as one JSON object per line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  try {
    const logger = createRunLogger({ baseDir: dir, runId: 'r' });
    logger.logTurn({ turnIndex: 2, workerStream: [{ a: 1 }, { b: 2 }] });
    const jsonl = fs.readFileSync(path.join(dir, 'r', 'turn-0002', 'worker_stream.jsonl'), 'utf8').trim();
    const lines = jsonl.split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
