// proc.js — REQ-001
// The ONLY module in this codebase allowed to call node:child_process.
// Everything else spawns through runProcess() so Windows .cmd/.exe handling,
// stdin closing, timeouts, and result shape stay in one auditable place.

import { spawn } from 'node:child_process';

// Extensions that are Windows shell shims and must run via `cmd.exe /c`.
const SHELL_EXTENSIONS = ['.cmd', '.bat'];

/**
 * Build the (command, args) pair for spawning, handling the Windows split:
 *   - `.cmd`/`.bat` shims  -> ['cmd.exe', '/c', shim, ...args]
 *   - everything else      -> [bin, ...args]  (spawned directly, no shell)
 *
 * Arguments are always discrete array elements — never joined into a string —
 * so values containing spaces are passed through without quoting hazards.
 */
export function buildSpawnArgs(bin, args = []) {
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new TypeError('buildSpawnArgs: bin must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new TypeError(
      'buildSpawnArgs: args must be an array of discrete arguments, never a joined command string',
    );
  }
  const lower = bin.toLowerCase();
  if (SHELL_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { command: 'cmd.exe', args: ['/c', bin, ...args] };
  }
  return { command: bin, args: [...args] };
}

/**
 * Terminate a process and its entire descendant tree. codex and claude both
 * shell to subprocesses internally, so killing only the root leaves orphans.
 */
function killTree(pid) {
  if (pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* best effort — the process may already be gone */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Spawn a child process and resolve to ONE normalized result shape:
 *   { code, signal, stdout, stderr, timedOut, durationMs, error }
 *
 * - Spawn/ENOENT errors are normalized (code: null, error set) — never thrown,
 *   so every caller branches on the same contract.
 * - stdin is always closed (optionally after writing `input`). Leaving stdin
 *   open hangs stdin-reading children such as `codex exec` (verified pitfall).
 * - `timeoutMs` fires a wall-clock timer that kills the whole process tree and
 *   sets `timedOut: true`.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, timeoutMs?:number, input?:string, onStdout?:(chunk:string)=>void}} [opts]
 */
export function runProcess(bin, args = [], opts = {}) {
  const { cwd, env, timeoutMs, input, onStdout } = opts;
  const { command, args: spawnArgs } = buildSpawnArgs(bin, args);

  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, spawnArgs, { cwd, env, shell: false, windowsHide: true });
    } catch (err) {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut: false,
        durationMs: Date.now() - start,
        error: { code: err.code ?? null, message: err.message },
      });
      return;
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
    }

    child.stdout?.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onStdout) {
        try {
          onStdout(s);
        } catch {
          /* a misbehaving stream consumer must never break the spawn */
        }
      }
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
        error: { code: err.code ?? null, message: err.message },
      });
    });

    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
        error: null,
      });
    });

    // Verified pitfall: a stdin-reading child (e.g. `codex exec`) blocks forever
    // until stdin reaches EOF. Always close stdin; write `input` first if given.
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* ignore EPIPE when the child exits before reading stdin */
      });
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    }
  });
}
