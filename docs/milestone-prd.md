# v1 Milestone Scratch PRD — `mathlib`

A deliberately tiny PRD used by `scripts/milestone.mjs` to exercise the **real**
closed loop (codex 监工 supervising a real Claude Code worker) end-to-end inside a
throwaway git repo. Small enough to finish inside one subscription quota window.

## Goal

Build a minimal, well-tested `mathlib` module with `node:test`.

## Tasks (seeded directly into `.taskmaster/tasks/tasks.json`)

1. **sum** — Add `export function sum(a, b)` to `lib/math.js` returning `a + b`,
   with a passing `test/math.test.js` case. Verify with `node --test`.
2. **isEven** — Add `export function isEven(n)` to `lib/math.js` returning whether
   `n` is even, with a passing test. Verify with `node --test`.
3. **clamp** — Add `export function clamp(x, lo, hi)` to `lib/math.js` bounding `x`
   to `[lo, hi]`, with a passing test. Verify with `node --test`.

Tasks are seeded directly (not via `task-master parse-prd`) to avoid the verified
`claude-code` provider hang on Windows — the milestone is about the **supervisor
loop**, not task-master's parser.

## What the milestone proves (live)

- The orchestrator boots, asserts both CLIs use **subscription** auth, and passes
  a sanitized env (no `*_API_KEY`) to every child process (REQ-012, REQ-019).
- codex drives a real Claude Code worker through the seeded tasks, judging each
  turn from ground truth and marking tasks done only on its own `task_complete`
  verdict (REQ-004 → REQ-008, REQ-010).
- A complete per-turn transcript lands under `runs/<runId>/` (REQ-013).

The adversarial drills — injected false-done detection (REQ-005/006) and the
escalation round-trip (REQ-011/014) — are proven **deterministically** in
`test/main.test.js`; forcing a real model to fake completion on demand is
unreliable, so those gates live in the test suite, not the live run.
