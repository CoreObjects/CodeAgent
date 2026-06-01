// resilience.js — REQ-017
// Failure classification + retry policy shared by the Claude Code runner
// (REQ-003) and the codex invocation (REQ-006). Two transient classes are
// handled mechanically:
//
//   auth_refresh — the agent's OAuth token lapsed. Retry the SAME operation
//                  exactly once. We NEVER inject an API key as a "fix"; each
//                  agent refreshes its own subscription token. A second auth
//                  failure escalates (REQ-011) rather than looping.
//   rate_limit   — back off with capped exponential delay and retry; past the
//                  failure cap, escalate instead of spinning indefinitely.
//
// Everything else ('none') is returned to the caller untouched — this module
// makes no judgment about success vs. a non-transient failure; that is the
// caller's (and ultimately codex's) concern.

const RATE_LIMIT_RE =
  /(rate[\s_-]?limit|too many requests|\b429\b|\b503\b|\b529\b|quota|usage limit|over ?loaded|resource[_-]?exhausted)/i;

const AUTH_RE =
  /(unauthorized|\b401\b|authentication[_\s-]?(?:error|failed|required)|auth[_\s-]?(?:error|expired)|token[_\s-]?(?:expired|refresh)|oauth|re-?authenticate|session expired|login again|run\s+\S+\s+login)/i;

/**
 * Classify a process/turn result (or a thrown error, or a raw string) into a
 * transient-failure class. Pure; never throws.
 * @returns {'rate_limit'|'auth_refresh'|'none'}
 */
export function classifyFailure(input) {
  if (input == null) return 'none';
  const text =
    typeof input === 'string'
      ? input
      : [input.stderr, input.stdout, input.message, input.error, input.finalText]
          .filter(Boolean)
          .map(String)
          .join('\n');
  const code = typeof input === 'object' ? input.exitCode ?? input.code ?? null : null;

  if (RATE_LIMIT_RE.test(text) || code === 429 || code === 503 || code === 529) return 'rate_limit';
  if (AUTH_RE.test(text) || code === 401) return 'auth_refresh';
  return 'none';
}

// Strong, unambiguous "you are out of quota" signals — specific enough to match
// the CLIs' own limit messages without false-positiving on normal code/output.
const QUOTA_LIMIT_RE =
  /(you'?ve hit your|session limit|usage limit|quota (?:exceeded|exhausted|reached)|rate limit(?:ed| exceeded| reached)|too many requests|\b429\b|resets?\s+\d{1,2}:\d{2}\s*[ap]m)/i;

/**
 * Classify a RESULT (not just a thrown error) for the recovery layer. The live
 * bug: claude RETURNED "You've hit your session limit …" as normal output (no
 * throw, exit 0), so a throw-only classifier missed it and the loop spun. This
 * inspects the result's text fields for a strong quota signal.
 * @returns {'rate_limit'|'auth_refresh'|'none'}
 */
export function classifyResult(r) {
  if (r == null) return 'none';
  if (r instanceof Error) return classifyFailure({ message: r.message, stderr: r.stderr });
  const text = [r.stderr, r.stdout, r.finalText, r.message].filter(Boolean).map(String).join('\n');
  return QUOTA_LIMIT_RE.test(text) ? 'rate_limit' : 'none';
}

function minutesOfDayInTz(now, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

/**
 * Parse a clock-time reset hint like "resets 11:20pm (America/Los_Angeles)" into
 * ms from `now` until the NEXT time that clock reads, in the given timezone (or
 * local if absent). null when there is no such hint. Pure (now injected).
 */
export function parseResetTimeMs(text, now = new Date()) {
  const m = String(text ?? '').match(/resets?\s+(\d{1,2}):(\d{2})\s*([ap])m\b(?:\s*\(([^)]+)\))?/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  const target = h * 60 + Number(m[2]);
  const cur = minutesOfDayInTz(now, m[4]);
  let delta = target - cur;
  if (delta <= 0) delta += 24 * 60;
  return delta * 60000;
}

/** Capped exponential backoff: baseMs * factor^attempt, clamped to capMs. Pure. */
export function nextBackoffMs(attempt, { baseMs = 1000, factor = 2, capMs = 60000 } = {}) {
  return Math.min(capMs, baseMs * Math.pow(factor, attempt));
}

/**
 * Extract a retry delay (ms) from an error/CLI message, or null. Handles
 * "try again in 2h13m", "retry after 120", "Retry-After: 45", "in 30 seconds".
 * Pure — lets recovery wait exactly as long as the server asks (transient vs quota).
 */
export function parseRetryAfterMs(text) {
  const s = String(text ?? '');
  const ctx = s.match(/(?:try )?again in|retry[- ]?after|please wait/i);
  if (ctx) {
    const tail = s.slice(ctx.index);
    let ms = 0;
    let found = false;
    for (const m of tail.matchAll(/(\d+)\s*(h|m|s)/gi)) {
      const n = Number(m[1]);
      const u = m[2].toLowerCase();
      ms += n * (u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000);
      found = true;
    }
    if (found) return ms;
    const bare = tail.match(/(\d+)/); // e.g. "retry after 120" (seconds)
    if (bare) return Number(bare[1]) * 1000;
  }
  return null;
}

/**
 * Run-level recovery for long interruptions (quota exhausted, network down). On a
 * transient failure: retry auth ONCE immediately (no API key); otherwise WAIT the
 * server-hinted reset time (or `longWaitMs`, default 2h) and retry. After
 * `maxAttempts` consecutive failures, throw an error tagged `recoveryExhausted`
 * so the caller prints it and exits cleanly — the user resumes later with the
 * memo/tasks intact. `sleep`/`onWait` are injected for fast deterministic tests.
 *
 * @param {() => Promise<any>} operation
 * @param {{classify?:Function, longWaitMs?:number, maxAttempts?:number, sleep?:Function, onWait?:Function, onAuthRetry?:Function}} [opts]
 */
export async function runWithRecovery(
  operation,
  { classify = classifyFailure, longWaitMs = 2 * 60 * 60 * 1000, maxAttempts = 3, bufferMs = 0, sleep = realSleep, onWait = () => {}, onAuthRetry = () => {} } = {},
) {
  let attempts = 0;
  let authRetried = false;

  for (;;) {
    let result;
    try {
      result = await operation();
    } catch (err) {
      result = err;
    }
    const kind = result instanceof Error ? classifyFailure({ message: result.message, stderr: result.stderr }) : classify(result);
    if (kind === 'none') return result;

    if (kind === 'auth_refresh' && !authRetried) {
      authRetried = true;
      onAuthRetry(); // single immediate retry, NEVER an API key
      continue;
    }

    attempts += 1;
    if (attempts >= maxAttempts) {
      const err = result instanceof Error ? result : new Error(`recovery exhausted (${kind}) after ${attempts} attempts`);
      err.recoveryExhausted = true;
      err.kind = kind;
      throw err;
    }
    // Wait the right amount: an explicit "try again in N" hint, else a parsed
    // clock reset time + buffer (e.g. "resets 11:20pm" -> wait until then +20min),
    // else the long-wait default. finalText is included so a session-limit message
    // RETURNED by the worker (the live bug) is seen.
    const text = result instanceof Error ? `${result.message} ${result.stderr ?? ''}` : [result?.stderr, result?.stdout, result?.finalText, result?.message].filter(Boolean).join('\n');
    const hinted = parseRetryAfterMs(text);
    let waitMs;
    if (hinted != null) waitMs = hinted;
    else {
      const reset = parseResetTimeMs(text);
      waitMs = reset != null ? reset + bufferMs : longWaitMs;
    }
    onWait({ attempt: attempts, waitMs, kind });
    await sleep(waitMs);
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation` under the transient-failure retry policy. A thrown error is
 * treated as a classifiable result. On a non-transient result ('none') the
 * result is returned as-is. On escalation, returns `{ escalated:true, kind, answer }`.
 *
 * @param {() => Promise<any>} operation
 * @param {{
 *   classify?: (r:any)=>'rate_limit'|'auth_refresh'|'none',
 *   maxRateLimitRetries?: number, baseMs?: number, factor?: number, capMs?: number,
 *   sleep?: (ms:number)=>Promise<void>,
 *   onEscalate: (info:{kind:string, attempt:number, message:string})=>Promise<string>,
 *   onAuthRetry?: ()=>void, onBackoff?: (info:{attempt:number, delayMs:number})=>void,
 * }} opts
 */
export async function runWithResilience(
  operation,
  {
    classify = classifyFailure,
    maxRateLimitRetries = 5,
    baseMs = 1000,
    factor = 2,
    capMs = 60000,
    sleep = realSleep,
    onEscalate,
    onAuthRetry = () => {},
    onBackoff = () => {},
  } = {},
) {
  let authRetried = false;
  let rateAttempts = 0;

  for (;;) {
    let result;
    try {
      result = await operation();
    } catch (err) {
      result = err; // a thrown error is just another result to classify
    }

    const kind = classify(result);
    if (kind === 'none') return result;

    if (kind === 'auth_refresh') {
      if (!authRetried) {
        authRetried = true;
        onAuthRetry(); // log-only hook — NEVER injects an API key
        continue; // retry the same operation once
      }
      const answer = await onEscalate({
        kind,
        attempt: rateAttempts,
        message: 'Authentication is still failing after a single re-auth retry.',
      });
      return { escalated: true, kind, answer };
    }

    // rate_limit
    if (rateAttempts >= maxRateLimitRetries) {
      const answer = await onEscalate({
        kind,
        attempt: rateAttempts,
        message: `Rate limited ${rateAttempts} times — backoff exhausted.`,
      });
      return { escalated: true, kind, answer };
    }
    const delayMs = nextBackoffMs(rateAttempts, { baseMs, factor, capMs });
    rateAttempts += 1;
    onBackoff({ attempt: rateAttempts, delayMs });
    await sleep(delayMs);
  }
}
