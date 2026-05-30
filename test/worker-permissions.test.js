import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkerSettings, ensureWorkerSettings } from '../src/worker-permissions.js';

// The worker is launched in `auto` permission mode with NO --allowedTools flag,
// so a per-repo .claude/settings.json drives allow/deny. deny rules survive
// `auto`/`bypassPermissions` (only prompts are skipped), so the HARDENED deny
// list below is the worker's real preventive boundary — string-prefix deny is
// bypassable, so we deny destructive command FAMILIES wholesale.

test('allow list whitelists the worker tools (incl. full shell on both OS shells)', () => {
  const { permissions } = buildWorkerSettings();
  for (const r of ['Bash(*)', 'PowerShell(*)', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
    assert.ok(permissions.allow.includes(r), `allow should include ${r}`);
  }
});

test('hardened deny blocks destructive command FAMILIES, not just one exact phrasing', () => {
  const { permissions } = buildWorkerSettings();
  const deny = permissions.deny;
  // filesystem destruction — whole verb, both shells
  for (const r of ['Bash(rm *)', 'Bash(rmdir *)', 'Bash(find *)', 'Bash(dd *)', 'PowerShell(Remove-Item *)', 'PowerShell(format *)']) {
    assert.ok(deny.includes(r), `deny should include ${r}`);
  }
  // git footguns that rewrite shared history / wipe work
  for (const r of ['Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git reset --hard*)', 'Bash(git clean *)']) {
    assert.ok(deny.includes(r), `deny should include ${r}`);
  }
  // the weak original (exact prefix only) must NOT be the protection on its own
  assert.ok(!deny.includes('Bash(rm -rf /*)'), 'must harden beyond the bypassable exact-prefix rule');
});

test('ensureWorkerSettings writes .claude/settings.json when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  try {
    const res = ensureWorkerSettings(dir);
    assert.equal(res.wrote, true);
    const p = path.join(dir, '.claude', 'settings.json');
    assert.equal(res.path, p);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(parsed.permissions.deny.includes('Bash(rm *)'));
    assert.ok(parsed.permissions.allow.includes('Bash(*)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureWorkerSettings does NOT clobber an existing settings.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  try {
    const p = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"permissions":{"allow":["Read"],"deny":[]},"_mine":true}', 'utf8');
    const res = ensureWorkerSettings(dir);
    assert.equal(res.wrote, false); // respected the repo's own config
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(parsed._mine, true); // untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureWorkerSettings overwrites when explicitly asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-'));
  try {
    const p = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"_mine":true}', 'utf8');
    const res = ensureWorkerSettings(dir, { overwrite: true });
    assert.equal(res.wrote, true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(parsed._mine, undefined);
    assert.ok(parsed.permissions.deny.includes('Bash(git reset --hard*)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
