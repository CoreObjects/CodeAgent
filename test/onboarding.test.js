import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoginGuidance } from '../src/onboarding.js';

// On the main command, a not-logged-in user must be GUIDED to sign in (both
// agents, subscription, never an API key) — not just told "refusing to run".

test('guidance names only the agent(s) that need login, mentions no API key', () => {
  const both = buildLoginGuidance({ claudeOk: false, codexOk: false });
  assert.match(both, /claude/i);
  assert.match(both, /codex login/i);
  assert.match(both, /Sign in with ChatGPT/i);
  assert.match(both, /API key/i);

  const codexOnly = buildLoginGuidance({ claudeOk: true, codexOk: false });
  assert.match(codexOnly, /codex login/i);
  assert.doesNotMatch(codexOnly, /Claude \(worker\)/); // claude is fine, don't nag about it

  const claudeOnly = buildLoginGuidance({ claudeOk: false, codexOk: true });
  assert.match(claudeOnly, /claude/i);
  assert.doesNotMatch(claudeOnly, /codex login/i);
});

test('mentions subscription and points at doctor to re-check', () => {
  const g = buildLoginGuidance({ claudeOk: false, codexOk: false });
  assert.match(g, /subscription/i);
  assert.match(g, /prd2code doctor/);
});
