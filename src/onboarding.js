// onboarding.js — login guidance (Phase 4, v3)
// When the startup probe can't reach an agent under subscription auth, the user
// must be GUIDED to log in — both agents, subscription only, never an API key.
// Used by the main command's startup and by `prd2code doctor`.

/**
 * @param {{claudeOk:boolean, codexOk:boolean}} probe
 * @returns {string}
 */
export function buildLoginGuidance({ claudeOk, codexOk }) {
  const lines = ['Not ready — subscription auth is unavailable. prd2code never uses an API key.'];
  if (!claudeOk) {
    lines.push('  ✗ Claude (worker): sign in to Claude Code with your Max plan — run `claude` and complete the login if prompted.');
  }
  if (!codexOk) {
    lines.push('  ✗ codex (supervisor): run `codex login` → Sign in with ChatGPT.');
  }
  lines.push('Then re-run, or re-check with: prd2code doctor');
  return lines.join('\n');
}
