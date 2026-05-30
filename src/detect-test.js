// detect-test.js
// Zero-config test-command detection. The supervisor runs a test command each
// turn as its own independent ground truth (REQ-004) — but the user shouldn't
// have to configure it. Inspect the repo's marker files and return the command,
// or null when there is no test setup yet (ground truth then falls back to git
// alone). Re-run every turn so it picks up the test harness as the worker builds
// it. A config/`--test` override always wins over this in the caller.

import fs from 'node:fs';
import path from 'node:path';

const exists = (dir, name) => fs.existsSync(path.join(dir, name));

function hasPytestLayout(dir) {
  if (['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini'].some((f) => exists(dir, f))) return true;
  // a tests/ (or test/) dir containing a test_*.py file
  for (const t of ['tests', 'test']) {
    const td = path.join(dir, t);
    try {
      if (fs.readdirSync(td).some((f) => /^test_.*\.py$/.test(f) || /_test\.py$/.test(f))) return true;
    } catch {
      /* not a dir */
    }
  }
  return false;
}

/**
 * @param {string} repoDir
 * @returns {string[]|null} the test command as a discrete-args array, or null.
 */
export function detectTestCommand(repoDir) {
  // Node first: only if there's an actual test script (a bare package.json would
  // give `npm test` -> "no test specified" exit 1, a false ground-truth signal).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    if (pkg?.scripts?.test) return ['npm', 'test'];
  } catch {
    /* no/invalid package.json */
  }

  if (hasPytestLayout(repoDir)) return ['python', '-m', 'pytest', '-q'];
  if (exists(repoDir, 'Cargo.toml')) return ['cargo', 'test'];
  if (exists(repoDir, 'go.mod')) return ['go', 'test', './...'];
  return null;
}
