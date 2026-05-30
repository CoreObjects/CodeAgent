// logging.js — REQ-013
// Per-turn transcript sink: persist worker stream, ground truth, evidence digest,
// codex prompt, and codex decision under runs/<runId>/turn-<n>/, plus a
// human-readable transcript.md with verdict + memo evolution. Token-shaped strings
// are scrubbed before anything reaches disk. No decision logic — a pure sink.

import fs from 'node:fs';
import path from 'node:path';

const REDACTIONS = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g, // Anthropic keys / OAuth access tokens
  /sk-proj-[A-Za-z0-9_-]{10,}/g, // OpenAI project keys
  /sk-[A-Za-z0-9_-]{20,}/g, // generic OpenAI-style keys
  /Bearer\s+[A-Za-z0-9._-]{10,}/gi, // bearer-token-shaped strings
];

/** Replace token-shaped substrings with [REDACTED]. */
export function redactSecrets(text) {
  let s = String(text);
  for (const re of REDACTIONS) s = s.replace(re, '[REDACTED]');
  return s;
}

/**
 * @param {{baseDir?:string, runId:string}} opts
 */
export function createRunLogger({ baseDir = 'runs', runId }) {
  const runDir = path.join(baseDir, runId);

  return {
    runDir,
    logTurn(turn) {
      const d = path.join(runDir, `turn-${String(turn.turnIndex).padStart(4, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      const write = (name, content) => fs.writeFileSync(path.join(d, name), redactSecrets(content), 'utf8');

      if (turn.workerStream != null) {
        const events = Array.isArray(turn.workerStream) ? turn.workerStream : [turn.workerStream];
        write('worker_stream.jsonl', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
      if (turn.groundTruth != null) write('ground_truth.json', JSON.stringify(turn.groundTruth, null, 2));
      if (turn.evidenceDigest != null) {
        write(
          'evidence_digest.json',
          typeof turn.evidenceDigest === 'string' ? turn.evidenceDigest : JSON.stringify(turn.evidenceDigest, null, 2),
        );
      }
      if (turn.codexPrompt != null) write('codex_prompt.txt', String(turn.codexPrompt));
      if (turn.codexDecision != null) write('codex_decision.json', JSON.stringify(turn.codexDecision, null, 2));

      const dec = turn.codexDecision ?? {};
      const summary = [
        `## Turn ${turn.turnIndex}`,
        `- verdict: ${dec.verdict ?? '-'}`,
        `- message_to_claude: ${dec.message_to_claude ?? '-'}`,
        `- memo (chars): ${(dec.updated_memo ?? '').length}`,
        '',
      ].join('\n');
      fs.mkdirSync(runDir, { recursive: true });
      fs.appendFileSync(path.join(runDir, 'transcript.md'), redactSecrets(summary) + '\n', 'utf8');
    },
  };
}
