import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexSystemPrompt } from '../src/codex-prompt.js';

// REQ-014: the codex supervisor system prompt (role + escalation whitelist + memo
// self-compaction + verified host pitfalls inlined from REQ-019).

test('states the supervisor role and the no-edit rule (11.1)', () => {
  const p = buildCodexSystemPrompt();
  assert.match(p, /supervisor|监工/);
  assert.match(p, /never edit/i);
  assert.match(p, /verdict/i);
});

test('enumerates all five escalation categories (11.2)', () => {
  const p = buildCodexSystemPrompt();
  for (const cat of ['irreversible', 'money', 'security_privacy_legal', 'scope_product', 'judgment_human_would_want']) {
    assert.match(p, new RegExp(cat));
  }
});

test('gives memo self-compaction guidance with the cap (11.3)', () => {
  const p = buildCodexSystemPrompt({ memoCap: 6000 });
  assert.match(p, /6000/);
  assert.match(p, /compact/i);
});

test('inlines the verified host pitfalls (11.4)', () => {
  const p = buildCodexSystemPrompt();
  assert.match(p, /python3/);
  assert.match(p, /task-master/);
  assert.match(p, /stdin/i);
});

test('mentions catching fake completion with cited facts', () => {
  const p = buildCodexSystemPrompt();
  assert.match(p, /fake_done_flag|fake/i);
});

test('tells codex it only sees the standard test command output and to wire criteria into it (no ad-hoc deadlock)', () => {
  const p = buildCodexSystemPrompt();
  assert.match(p, /standard test command/i);
  assert.match(p, /ad-hoc|one-off/i);
  assert.match(p, /addopts|--cov/);
});
