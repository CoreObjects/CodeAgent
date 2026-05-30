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

/** Capped exponential backoff: baseMs * factor^attempt, clamped to capMs. Pure. */
export function nextBackoffMs(attempt, { baseMs = 1000, factor = 2, capMs = 60000 } = {}) {
  return Math.min(capMs, baseMs * Math.pow(factor, attempt));
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
