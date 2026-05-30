// worker-permissions.js
// The worker's per-repo permission boundary. The orchestrator launches the
// worker in `auto` permission mode with NO --allowedTools flag, so a
// `.claude/settings.json` in the target repo drives allow/deny. deny rules are
// STILL enforced under auto/bypassPermissions (only the prompts are skipped), so
// this deny list is the real PREVENTIVE control — codex is read-only and only
// reviews AFTER a turn, so a destructive command runs before codex ever sees it.
//
// String-prefix deny is bypassable by rephrasing (`rm -fr`, double spaces, full
// path, a different command). We therefore deny destructive command FAMILIES
// wholesale rather than one exact phrasing. This intentionally costs the worker
// raw `rm`/`find` etc.; it keeps `git rm`, Edit/Write, and everything non-
// destructive. Residual holes remain by design (`Bash(*)` allows arbitrary code,
// including pipe-to-shell) — the durable boundary is an isolated run environment.

import fs from 'node:fs';
import path from 'node:path';

const ALLOW = [
  'Skill(*)', // not a documented permission rule today — inert but harmless
  'Bash(*)',
  'PowerShell(*)',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

const DENY = [
  // --- irreversible filesystem destruction (deny the verb, both shells) ---
  'Bash(rm *)',
  'Bash(rmdir *)',
  'Bash(find *)', // find can -delete / -exec rm
  'Bash(dd *)',
  'Bash(shred *)',
  'Bash(mkfs *)',
  'PowerShell(Remove-Item *)',
  'PowerShell(ri *)',
  'PowerShell(rm *)',
  'PowerShell(del *)',
  'PowerShell(rd *)',
  'PowerShell(rmdir *)',
  'PowerShell(Clear-Content *)',
  'PowerShell(Clear-Disk *)',
  'PowerShell(Format-Volume *)',
  'PowerShell(format *)',
  // --- privilege / recursive permission changes ---
  'Bash(sudo *)',
  'Bash(chmod -R*)',
  'Bash(chown -R*)',
  // --- git footguns: rewrite shared history or wipe work (both shells) ---
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git reset --hard*)',
  'Bash(git clean *)',
  'PowerShell(git push --force*)',
  'PowerShell(git push -f*)',
  'PowerShell(git reset --hard*)',
  'PowerShell(git clean *)',
];

/** The worker permission settings object (pure). deny takes precedence over allow. */
export function buildWorkerSettings() {
  return { permissions: { allow: [...ALLOW], deny: [...DENY] } };
}

/**
 * Provision `<repoDir>/.claude/settings.json` with the worker permissions.
 * By default it does NOT clobber an existing file (respect the repo's own
 * config); pass { overwrite:true } to force. Returns { path, wrote }.
 */
export function ensureWorkerSettings(repoDir, { overwrite = false, fsImpl = fs } = {}) {
  const dir = path.join(repoDir, '.claude');
  const p = path.join(dir, 'settings.json');
  if (!overwrite && fsImpl.existsSync(p)) return { path: p, wrote: false };
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(p, JSON.stringify(buildWorkerSettings(), null, 2) + '\n', 'utf8');
  return { path: p, wrote: true };
}
