# PRD: Supervisor Agent — codex (监工) driving Claude Code to implement a PRD

**Author:** CoreObjects
**Date:** 2026-05-29
**Status:** Draft
**Version:** 1.0
**Taskmaster Optimized:** Yes

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Goals & Success Metrics](#goals--success-metrics)
4. [User Stories](#user-stories)
5. [Functional Requirements](#functional-requirements)
6. [Non-Functional Requirements](#non-functional-requirements)
7. [Technical Considerations](#technical-considerations)
8. [Environment Constraints & Verified Pitfalls](#environment-constraints--verified-pitfalls)
9. [Implementation Roadmap](#implementation-roadmap)
10. [Out of Scope](#out-of-scope)
11. [Open Questions & Risks](#open-questions--risks)
12. [Validation Checkpoints](#validation-checkpoints)
13. [Appendix: Task Breakdown Hints](#appendix-task-breakdown-hints)

---

## Executive Summary

Turning a PRD into working code with Claude Code today requires a human to babysit the session — repeatedly typing "continue", "no, rewrite that", "you are not done yet", and answering the worker's mid-task questions. We are building a **supervisor agent** in which **codex (the 监工) is the brain** and **Claude Code is the worker**. A thin Node orchestrator carries zero decision logic: each turn it runs Claude Code for one turn, collects ground-truth evidence (git diff, test exit codes, actual tool calls), hands that evidence to codex, and mechanically executes codex's verdict (continue / rewrite / task complete / escalate / abort). codex reasons its way through every deviation — including unforeseen ones — exactly as the human used to. Both agents run on subscription login (no API keys). The target outcome is unattended PRD-to-code execution where the human is consulted only for a small whitelist of high-stakes decisions.

---

## Problem Statement

### Current Situation

The existing trunk (`prd-taskmaster`: PRD → `task-master parse-prd` → `task-master expand-all` → per-task implementation) describes an ideal path. In practice, a Claude Code worker run drifts: it asks clarifying questions mid-task, stops after doing partial work, claims a task is complete when the code or tests do not support that claim, and encounters branches that cannot be enumerated in advance. Today a human sits at the terminal and steers through every one of these.

### User Impact

- **Who is affected:** The single developer (the project owner) who runs PRD-driven implementation with Claude Code.
- **How they are affected (pain points):** The developer cannot step away — they must watch the stream, judge each turn, push back on stalls, and detect false completion claims by hand. A multi-hour implementation run consumes multi-hours of human attention.
- **Severity:** High — the supervision burden makes unattended runs impossible and caps throughput at one human-supervised session at a time.

### Business Impact

- **Cost of the problem:** Developer hours spent babysitting rather than on higher-value work; measured baseline is approximately 100% of run wall-clock time requiring active human attention.
- **Opportunity cost:** Runs cannot proceed overnight or in parallel because each needs a human in the loop.
- **Strategic importance:** A working supervisor agent converts Claude Code from a hand-held tool into an unattended implementation engine, which is the core capability this project exists to build.

### Why Solve This Now

Both required command-line agents are installed and authenticated by subscription on the target machine, and the headless interfaces needed (Claude Code `stream-json`, codex `exec` with output schema) are confirmed present. The integration surface exists today.

---

## Goals & Success Metrics

### Goal 1: Replace the human supervisor with codex

- **Description:** codex makes every per-turn steering decision (continue, rewrite, complete, escalate) so the developer does not have to.
- **Metric:** Share of worker turns that require human input during a run.
- **Baseline:** 100% (every turn is human-driven today).
- **Target:** 0% of turns require human input except whitelisted escalations (see Goal 3).
- **Timeframe:** v1 milestone run.
- **Measurement Method:** Per-turn transcript log; count turns with a human prompt versus total turns.

### Goal 2: Catch false completion claims using ground-truth evidence

- **Description:** When the worker claims a task is done but git diff or test exit codes contradict that claim, codex flags it and redirects the worker instead of marking the task complete.
- **Metric:** Detection rate on deliberately injected false-"done" turns.
- **Baseline:** Not applicable (no automated detection exists).
- **Target:** 100% detection on the injected-fake test set in the v1 milestone, with zero tasks marked complete on empty-diff or failing-test evidence.
- **Timeframe:** v1 milestone run.
- **Measurement Method:** Injected-fake verification drill; assert codex returns `fake_done_flag: true` with cited evidence and the orchestrator did not set task status to done.

### Goal 3: Stay within subscription usage caps via bounded context

- **Description:** codex receives a bounded context each turn (role + goal + rolling memo + this-turn evidence), not a growing transcript, so two subscription agents fit inside shared 5-hour and weekly usage windows.
- **Metric:** Per-turn evidence digest size and rolling memo size.
- **Baseline:** Unbounded (a naive transcript grows without limit).
- **Target:** Evidence digest ≤ 6000 characters per turn; rolling memo ≤ 6000 characters; zero API-billed calls (100% subscription auth).
- **Timeframe:** v1 milestone run.
- **Measurement Method:** Logged byte counts per turn; provider dashboards show 0 API usage after the run.

---

## User Stories

### Story 1: Unattended per-turn steering

**As a** developer running a PRD implementation,
**I want** codex to decide the next instruction after each worker turn,
**So that I can** step away instead of typing "continue" / "rewrite" myself.

**Acceptance Criteria:**
- [ ] After each Claude Code turn the orchestrator calls codex and receives a structured decision.
- [ ] The orchestrator relays codex's `message_to_claude` to the worker byte-for-byte without rewriting it.
- [ ] The orchestrator contains no branch that inspects the diff or evidence to choose the worker's next instruction.
- [ ] A run advances across at least three tasks with no human input on non-escalation turns.
- [ ] Every decision is written to the per-turn transcript.

**Task Breakdown Hint:**
- Task: implement the per-turn loop wiring (~6h)
- Task: implement codex invocation + decision parsing (~6h)
- Task: implement verbatim relay of the next instruction (~2h)

**Dependencies:** REQ-003, REQ-006, REQ-007, REQ-008

### Story 2: Expose a false "done" with evidence

**As a** developer,
**I want** codex to detect when the worker claims completion without real changes or passing tests,
**So that I can** trust that a task marked done is actually done.

**Acceptance Criteria:**
- [ ] The orchestrator collects git diff and test exit code independently of the worker's own statements each turn.
- [ ] The evidence digest separates the worker's claims from observed facts.
- [ ] When claims and facts diverge, codex returns a redirect verdict with `fake_done_flag: true` and at least one cited evidence item.
- [ ] The orchestrator does not mark a task complete on a turn with empty changed-files or a non-zero test exit code unless codex's cited evidence supports completion.
- [ ] The divergence is recorded in the transcript.

**Task Breakdown Hint:**
- Task: implement ground-truth collector (~5h)
- Task: implement evidence digest with claims-versus-facts layout (~5h)
- Task: encode evidence requirement in the codex decision schema (~2h)

**Dependencies:** REQ-004, REQ-005, REQ-006

### Story 3: Escalate only whitelisted high-stakes decisions

**As a** developer,
**I want** codex to handle everything by default but pause and ask me for a defined whitelist of high-stakes decisions,
**So that I can** stay out of the loop without ceding decisions I should own.

**Acceptance Criteria:**
- [ ] codex is given the escalation whitelist as prompt text and decides membership itself.
- [ ] On an escalate verdict the orchestrator pauses, surfaces the question on the console, and waits for typed input.
- [ ] The human's answer is routed back to codex, not injected directly to the worker.
- [ ] codex re-decides after the human answer and the run continues.
- [ ] Each escalation question and answer is recorded in the transcript.

**Task Breakdown Hint:**
- Task: write codex system prompt with escalation whitelist (~3h)
- Task: implement escalation pause/prompt/resume channel (~4h)
- Task: route human answer back through codex (~2h)

**Dependencies:** REQ-011, REQ-014

### Story 4: Audit the run after the fact

**As a** developer,
**I want** a complete per-turn transcript,
**So that I can** verify that judgment lived in codex and reconstruct what happened.

**Acceptance Criteria:**
- [ ] Each turn writes the worker stream, ground truth, evidence digest, codex prompt, and codex decision to disk.
- [ ] The rolling memo evolution is recorded across turns.
- [ ] Token-shaped strings are scrubbed before any content is logged.
- [ ] A human-readable transcript summary is produced alongside the machine-readable log.

**Task Breakdown Hint:**
- Task: implement per-turn logging to JSONL plus a readable summary (~5h)
- Task: implement secret redaction (~2h)

**Dependencies:** REQ-013

---

## Functional Requirements

### Must Have (P0) — Critical for the v1 milestone

#### REQ-001: Subprocess wrapper for Windows command-line agents
**Priority:** P0 (Must Have)
**Description:** A single module must be the only place that spawns child processes. It must launch `.cmd` shims (`claude.cmd`, `task-master.cmd`) via `cmd.exe /c` with arguments passed as an array, and launch `.exe` binaries (`codex.exe`) directly without a shell. It must enforce a per-call wall-clock timeout and terminate the entire child process tree on timeout.

**Acceptance Criteria:**
- [ ] Spawning a `.cmd` shim returns exit code and output without an ENOENT error.
- [ ] Spawning a `.exe` directly returns exit code and output.
- [ ] A call exceeding the configured timeout is terminated together with its descendants and reports a timeout flag.
- [ ] Arguments containing spaces are passed through an array, never concatenated into one string.

**Task Breakdown:** Implement spawn wrapper and timeout/kill-tree: Medium (5h). Write unit tests with fake processes: Small (3h).
**Dependencies:** None (foundation module).

#### REQ-002: Line-buffered NDJSON stream parser
**Priority:** P0 (Must Have)
**Description:** A parser must consume a byte stream, split on newline, parse only complete JSON lines, retain a trailing partial line across chunks, tolerate non-JSON lines by routing them to a raw channel, and strip carriage returns.

**Acceptance Criteria:**
- [ ] A JSON object split across two chunks is parsed once both chunks arrive.
- [ ] A non-JSON line does not throw and is captured on the raw channel.
- [ ] Carriage-return characters are removed before parsing.

**Task Breakdown:** Implement parser: Small (3h). Unit tests for chunk/partial/CRLF/garbage cases: Small (3h).
**Dependencies:** None.

#### REQ-003: Claude Code one-turn runner
**Priority:** P0 (Must Have)
**Description:** A module must run Claude Code for exactly one worker turn in headless mode using `--output-format stream-json --verbose`, capture the session id from the init event, resume prior turns with `--resume <session_id>`, and return a normalized turn object containing the worker's text, the tool-use calls made, tool results, and the terminal result event. It must never pass `--bare`.

**Acceptance Criteria:**
- [ ] The runner returns only after the stream `result` event arrives or the process exits or times out.
- [ ] The session id from the first turn is reused to resume subsequent turns.
- [ ] The returned object lists each tool-use call and whether each tool result reported an error.
- [ ] The worker runs without interactive permission prompts using the configured permission mode and allow-list.

**Task Breakdown:** Implement runner and argument builder: Medium (6h). Implement turn normalization: Small (4h). Tests with recorded streams: Small (4h).
**Dependencies:** REQ-001, REQ-002.

#### REQ-004: Ground-truth collector
**Priority:** P0 (Must Have)
**Description:** A module must observe repository state independently of the worker's statements: snapshot HEAD and porcelain status before the turn, then after the turn produce git diff statistics, the changed-file list, porcelain status, and, when a test command is configured, run it and capture its exit code plus an output tail.

**Acceptance Criteria:**
- [ ] The collector reports the changed-file list scoped to the turn using the pre-turn HEAD snapshot.
- [ ] The collector reports the test command exit code when a test command is configured.
- [ ] The collector performs no interpretation and emits only observed values.

**Task Breakdown:** Implement git snapshot/diff/status collection: Medium (5h). Implement optional test runner capture: Small (3h).
**Dependencies:** REQ-001.

#### REQ-005: Bounded evidence digest
**Priority:** P0 (Must Have)
**Description:** A module must merge the worker turn (claims) with ground truth (facts) into a bounded structured digest that separates the two so divergence is visible. It must hard-cap every free-text field, cap arrays with an overflow sentinel, and keep only the tail of test output.

**Acceptance Criteria:**
- [ ] The digest contains a claims block and a facts block as distinct fields.
- [ ] The total serialized digest is at most 6000 characters.
- [ ] Mechanical divergence hints (claimed-done-but-no-diff, tests-referenced-but-not-run, tool-errors-present) are emitted as data, and no code path acts on them to choose a verdict.

**Task Breakdown:** Implement digest builder and bounding: Medium (5h). Tests for caps and divergence hints: Small (3h).
**Dependencies:** REQ-003, REQ-004.

#### REQ-006: codex supervisor invocation with enforced decision schema
**Priority:** P0 (Must Have)
**Description:** A module must invoke codex non-interactively with `exec`, sandbox `read-only`, approval policy `never` (set via `-c approval_policy="never"`), an output schema file, and an output-last-message file. It must pass a bounded prompt (role + goal + rolling memo + this-turn evidence), read the decision file, validate it against the schema locally, and on malformed output re-ask once before escalating.

**Acceptance Criteria:**
- [ ] codex is always launched with sandbox `read-only` so it cannot modify files.
- [ ] The returned decision validates against the decision schema, including at least one cited evidence item.
- [ ] A malformed decision triggers exactly one re-ask; a second failure produces an escalate outcome rather than a guessed verdict.
- [ ] The prompt passed to codex contains only the bounded context, not a growing transcript.

**Task Breakdown:** Implement codex invocation and argument set: Medium (6h). Implement schema validation and one-retry path: Medium (4h).
**Dependencies:** REQ-005, REQ-012.

#### REQ-007: Verdict router (mechanical switch)
**Priority:** P0 (Must Have)
**Description:** A pure function must map a decision verdict enum (continue, redirect, task_complete, escalate, abort) to a tagged orchestrator action. It must not read assessment text, cited evidence, or the diff to alter behavior.

**Acceptance Criteria:**
- [ ] Every enum value maps to exactly one action.
- [ ] The function reads only the verdict field and the next-message / question fields it forwards.
- [ ] Unit tests cover every enum value.

**Task Breakdown:** Implement router: Small (2h). Exhaustive enum tests: Small (2h).
**Dependencies:** REQ-006.

#### REQ-008: Per-turn control loop
**Priority:** P0 (Must Have)
**Description:** The loop must fetch the on-deck task from the trunk, run one worker turn, collect ground truth, build the digest, call codex, persist the updated memo, and route the verdict, repeating until codex returns task_complete and then advancing to the next task. The loop must contain no deviation taxonomy.

**Acceptance Criteria:**
- [ ] The only loop-side branches are turn-completion detection, the verdict switch, and numeric safety guards that escalate to a human.
- [ ] On task_complete the loop sets the task status to done through the trunk and fetches the next task.
- [ ] On abort the loop stops and records the reason.

**Task Breakdown:** Implement loop sequencing: Medium (6h). Integration test across multiple tasks: Medium (5h).
**Dependencies:** REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-009, REQ-010.

#### REQ-009: Rolling memo store
**Priority:** P0 (Must Have)
**Description:** A module must persist the codex-authored rolling memo verbatim and replay it verbatim on the next turn under a fixed delimiter. It must enforce a maximum size and, on overflow, warn in the log and pass the memo through rather than truncating it.

**Acceptance Criteria:**
- [ ] The memo content written is exactly the `updated_memo` codex returned.
- [ ] The memo is replayed into the next codex prompt under the agreed delimiter.
- [ ] An over-cap memo produces a log warning and is not silently truncated.

**Task Breakdown:** Implement memo read/write and bound: Small (3h). Tests: Small (2h).
**Dependencies:** None.

#### REQ-010: Trunk wrapper for task-master
**Priority:** P0 (Must Have)
**Description:** A module must shell `task-master next`, `task-master show <id>`, and `task-master set-status` as pass-through calls. It must never decide on its own whether a task is complete.

**Acceptance Criteria:**
- [ ] `next` returns the on-deck task identifier and details.
- [ ] `set-status` marks a task done only when called by the loop after a task_complete verdict.
- [ ] The wrapper contains no completion judgment.

**Task Breakdown:** Implement wrapper and output parsing: Medium (4h). Tests with recorded outputs: Small (3h).
**Dependencies:** REQ-001.

#### REQ-011: Escalation channel
**Priority:** P0 (Must Have)
**Description:** A module must pause the run, present codex's escalation question on the console in a delimited block, block on typed input, return the answer to the caller for routing back to codex, and record the exchange. A desktop notification is optional and degrades to console-only when unavailable.

**Acceptance Criteria:**
- [ ] The run pauses and displays the question until the human types an answer.
- [ ] The answer is returned to the loop, which routes it to codex rather than to the worker.
- [ ] The question and answer are recorded in the transcript.

**Task Breakdown:** Implement console prompt and capture: Small (4h). Optional notification with fallback: Small (2h).
**Dependencies:** REQ-008.

#### REQ-012: Configuration and subscription-auth hardening
**Priority:** P0 (Must Have)
**Description:** A module must load and validate configuration, resolve absolute paths to the `claude`, `codex`, and `task-master` binaries (failing immediately when missing), and pass a sanitized environment to child processes that strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. A startup probe must confirm both agents respond under subscription auth before a run begins.

**Acceptance Criteria:**
- [ ] Missing binaries cause an immediate failure with a clear message.
- [ ] Child processes receive an environment with no `*_API_KEY` variables.
- [ ] The startup probe runs a trivial prompt against each agent and both succeed under subscription auth.
- [ ] The `--bare` flag is never passed to Claude Code.

**Task Breakdown:** Implement config load/validation and path resolution: Medium (5h). Implement env sanitization and startup probe: Small (4h).
**Dependencies:** REQ-001.

#### REQ-013: Per-turn transcript logging
**Priority:** P0 (Must Have)
**Description:** A module must write per-turn artifacts (worker stream, ground truth, evidence digest, codex prompt, codex decision) and append a human-readable summary, after scrubbing token-shaped strings.

**Acceptance Criteria:**
- [ ] Each turn produces machine-readable artifacts on disk under a per-run directory.
- [ ] A human-readable summary is appended per turn.
- [ ] Token-shaped strings are scrubbed before writing.

**Task Breakdown:** Implement logging layout and writers: Medium (5h). Implement redaction and tests: Small (3h).
**Dependencies:** None.

### Should Have (P1) — Important but not blocking the milestone

#### REQ-014: codex system prompt and escalation whitelist
**Priority:** P1 (Should Have)
**Description:** A prompt file must define codex's role as supervisor, instruct it never to edit code itself, define the escalation whitelist (irreversible or destructive operations, spending real money, security/privacy/legal trade-offs, product or scope decisions not settled by the PRD, or anything codex judges the human would want to decide), and instruct it to self-compact the rolling memo under the size cap.

**Acceptance Criteria:**
- [ ] The prompt enumerates the escalation categories.
- [ ] The prompt instructs codex to act only through verdicts and never edit files.
- [ ] The prompt instructs codex to keep the memo within the size cap.
- [ ] The prompt includes the host's verified pitfalls (see Environment Constraints) so codex directs the worker to the verified path from the first turn rather than rediscovering them.

**Task Breakdown:** Draft and iterate the system prompt: Medium (4h).
**Dependencies:** REQ-006.

#### REQ-015: Worker bootstrap prompt
**Priority:** P1 (Should Have)
**Description:** A prompt file must give Claude Code concise worker behavior guidance aligned with the PRD trunk and the test command.

**Acceptance Criteria:**
- [ ] The bootstrap states the worker's role and the test command to run.
- [ ] The bootstrap does not impose a rigid output schema on the worker.

**Task Breakdown:** Draft worker bootstrap: Small (2h).
**Dependencies:** REQ-003.

#### REQ-016: Non-progress safety guard
**Priority:** P1 (Should Have)
**Description:** A mechanical counter must track consecutive turns with an empty changed-file list and unchanged test exit code, and at a configured threshold escalate to a human. It must never auto-abort or judge correctness.

**Acceptance Criteria:**
- [ ] The counter increments only on no-change turns and resets on change.
- [ ] At the threshold the guard escalates to a human and takes no other action.

**Task Breakdown:** Implement guard counter and threshold escalate: Small (3h).
**Dependencies:** REQ-008, REQ-011.

#### REQ-017: Rate-limit and transient-failure backoff
**Priority:** P1 (Should Have)
**Description:** The orchestrator must detect rate-limit and authentication-refresh failure signatures from either agent, retry the same turn once after a backoff for auth refresh, apply capped exponential backoff for rate limits, and after a configured number of failures escalate rather than spin.

**Acceptance Criteria:**
- [ ] An auth-refresh failure retries the same turn once and never injects an API key.
- [ ] Rate-limit responses trigger capped exponential backoff.
- [ ] Repeated failures past the cap escalate to a human.

**Task Breakdown:** Implement failure classification and backoff: Medium (5h).
**Dependencies:** REQ-003, REQ-006.

#### REQ-019: Environment preflight and verified invocation helper
**Priority:** P1 (Should Have)
**Description:** A preflight helper must verify the host-specific verified invocation paths before a run and expose them to codex and the worker, so neither rediscovers environment pitfalls at runtime. It must confirm: the real Python interpreter (`python`, not the `python3` Store stub) with `PYTHONUTF8=1` for UTF-8 files; the hyphenated `task-master` binary; that the worker is driven through the `claude` CLI directly rather than the task-master agent-SDK provider (which blocks on this platform); and that codex is logged in under ChatGPT subscription. The verified steps must be recorded as a callable script that the task-breakdown phase invokes directly rather than rediscovering them each run.

**Acceptance Criteria:**
- [ ] The preflight reports the resolved `python` and `task-master` paths and fails with a clear message when only the Store stub is present.
- [ ] The preflight confirms a headless `claude -p` round-trip returns under subscription before a run begins.
- [ ] The verified task-generation path exists as a callable script, not steps repeated by hand each run.
- [ ] The recorded pitfalls are passed into codex's system prompt so the worker is directed to the verified path from the first turn.

**Task Breakdown:** Implement preflight checks: Small (4h). Extract the verified task-generation path into a callable script: Small (4h).
**Dependencies:** REQ-012, REQ-014.

### Nice to Have (P2) — Future enhancement

#### REQ-018: codex session resume as memory backend
**Priority:** P2 (Nice to Have)
**Description:** As an optional alternative to the rolling memo, the orchestrator could use `codex exec resume <session_id>` to preserve codex memory across turns.

**Acceptance Criteria:**
- [ ] Resume mode is opt-in via configuration and defaults off.
- [ ] When off, the rolling memo remains the memory backend.

**Task Breakdown:** Prototype resume-backed memory: Medium (6h).
**Dependencies:** REQ-006, REQ-009.

---

## Non-Functional Requirements

### Performance & Budget

- Per-turn evidence digest: at most 6000 characters.
- Rolling memo: at most 6000 characters.
- Claude Code worker turn wall-clock timeout: 1800 seconds, after which the process tree is terminated.
- codex supervisor turn wall-clock timeout: 600 seconds.
- API-billed calls during a run: 0 (100% subscription auth).

### Authentication & Process Isolation

- codex must run with sandbox `read-only` for 100% of invocations, so file modifications by the supervisor are blocked at the process level.
- Child-process environment must contain 0 variables matching `*_API_KEY`.
- Auth-refresh handling must rely on each agent's own token refresh; the orchestrator reimplements 0 auth logic.

### Reliability

- A malformed codex decision must trigger exactly 1 re-ask before escalation.
- A non-progress run must escalate to a human within a configured threshold of consecutive no-change turns (default 3).
- Repeated rate-limit failures must escalate after a configured cap rather than retrying without limit.

### Compatibility

- Target platform: Windows 11, PowerShell, Node.js 20+ (verified Node 24.15.0 present).
- Command-line dependencies: Claude Code 2.1.150, codex 0.60.1, task-master 0.43.1.

---

## Technical Considerations

### System Architecture

The orchestrator is a thin Node component. The architecture places all judgment in codex and keeps the orchestrator as a pass-through integration layer between three command-line agents and the git working tree.

```
 task-master next  ──►  GOAL (the on-deck task)
        │
        ▼  (per-task turn loop until codex returns task_complete)
  ┌────────────────────────────────────────────────────────────┐
  │ 1. Run Claude Code one turn (stream-json, --resume)          │
  │ 2. Detect turn complete = stream {type:"result"} event       │
  │ 3. Collect ground truth (git diff/status, test exit code)    │
  │ 4. Build bounded evidence digest = claims vs facts           │
  │ 5. codex exec (read-only, approval_policy=never,             │
  │      --output-schema)  ->  structured decision               │
  │ 6. Persist codex updated_memo (replayed next turn)           │
  │ 7. router: switch(verdict) -> mechanical action              │
  └────────────────────────────────────────────────────────────┘
```

**Key Components:**
1. **proc** — the only module that spawns child processes (Windows `.cmd` vs `.exe`, timeout, kill-tree).
2. **claude-runner** — one worker turn via stream-json; resume by session id.
3. **ground-truth** — git diff/status and test exit code, independent of worker claims.
4. **evidence-digest** — claims-versus-facts bounded structure.
5. **codex-supervisor** — codex invocation, schema-enforced decision, one retry.
6. **router** — verdict enum to action; a pure switch.
7. **loop** — per-turn sequencing with no deviation taxonomy.
8. **memo-store**, **task-trunk**, **escalation**, **config**, **logging**, **redact** — supporting single-responsibility modules.

This is a greenfield design with a clear integration boundary: the orchestrator never makes a correctness judgment; it only relays evidence to codex and executes codex's decision.

### codex Decision Contract (output schema)

The decision returned by codex is constrained by a JSON schema and validated locally.

```json
{
  "type": "object",
  "required": ["assessment", "verdict", "cited_evidence", "updated_memo"],
  "properties": {
    "assessment": { "type": "string" },
    "verdict": { "enum": ["continue", "redirect", "task_complete", "escalate", "abort"] },
    "message_to_claude": { "type": "string" },
    "escalation_question": { "type": "string" },
    "escalation_category": { "enum": ["irreversible","money","security_privacy_legal","scope_product","judgment_human_would_want","none"] },
    "cited_evidence": { "type": "array", "minItems": 1 },
    "fake_done_flag": { "type": "boolean" },
    "updated_memo": { "type": "string" }
  }
}
```

Routing on `verdict` is a mechanical mapping: the orchestrator cannot distinguish a well-judged continue from a poorly judged one, because it never reads the assessment or evidence to alter behavior. All semantics live in how codex fills the enum.

### Evidence Digest Structure

The digest separates the worker's claims from observed facts so that codex can detect a false completion:

- **claims:** the worker's final text, stop reason, result subtype, tool-use count.
- **actions_taken:** each tool-use call and whether its result reported an error.
- **ground_truth:** HEAD before/after, diff statistics, changed-file list, porcelain status, test exit code and output tail.
- **divergence_hints:** mechanical flags (claimed-done-but-no-diff, tests-referenced-but-not-run, tool-errors-present) provided as data only.

### Technology Stack

- **Runtime:** Node.js ESM, standard library first (`child_process`, `readline`, `fs`, `path`, `crypto`, `os`).
- **Optional dependencies:** `ajv` for local schema validation; `node-notifier` for an optional desktop notification with console fallback.
- **No build step** for the first version to keep the integration layer auditable.

### External Dependencies

- **Claude Code CLI (worker):** headless `stream-json` interface; subscription OAuth; never invoked with `--bare`.
- **codex CLI (supervisor):** `exec` with `read-only` sandbox, `approval_policy=never`, output schema; ChatGPT subscription auth; resolved by absolute path or global install.
- **task-master CLI (trunk):** `parse-prd`, `expand-all`, `next`, `set-status`. Note: the command is `task-master` (hyphenated); the `prd-taskmaster` helper script's `taskmaster` lookup does not match on this install and is bypassed.

### Testing Strategy

- **Unit tests** with a fake spawn: stream parser (chunked, partial, CRLF, garbage), router (every enum value), digest bounding caps, proc argument construction for `.cmd` versus `.exe`, codex malformed-output retry, redaction.
- **Integration test** across multiple tasks on a throwaway PRD in a scratch repository.
- **Verification drills:** subscription-auth probe, codex read-only file-write attempt, injected false-"done" detection, escalation round-trip.

---

## Environment Constraints & Verified Pitfalls

These were observed on the target host (Windows 11, GBK locale, subscription auth) while generating this PRD's own task breakdown. The supervisor agent and the build must account for them so they do not repeat them at runtime.

- **`python3` is the Microsoft Store stub** (exits 49 with no output). Use `python` (CPython 3.10.7). Scripts that read UTF-8 must run under `PYTHONUTF8=1` because the host locale is GBK and Python otherwise decodes files as GBK and raises an error.
- **The CLI is `task-master` (hyphenated).** The `prd-taskmaster` helper script resolves `taskmaster` (no hyphen) and therefore cannot detect or initialize on this host; call `task-master` directly.
- **task-master's `claude-code` provider blocks on this platform.** It drives the worker through the bundled `@anthropic-ai/claude-agent-sdk`, which never spawned a worker child and blocked past 16 minutes during `parse-prd`. Headless `claude -p --output-format json`, by contrast, returns in about 3 seconds under the Max subscription with no API key.
- **codex `exec` is verified as the supervisor call-path** under ChatGPT subscription. It **blocks reading stdin until EOF** (this caused an earlier multi-minute stall), so the orchestrator must close stdin or pipe the evidence digest deliberately. `-s read-only` is enforced on this host (a codex write attempt was rejected by policy, so codex cannot edit files), `--output-schema` returns schema-valid JSON written to the `-o` file, and per-turn latency is on the order of 10 to 30 seconds. Invocation: `codex exec --json -s read-only -c approval_policy="never" --skip-git-repo-check --output-schema <file> -o <file>`.
- **Design implication:** the orchestrator drives the `claude` CLI directly (REQ-003) and never the agent-SDK provider; a preflight plus a callable verified script (REQ-019) establishes the verified invocation; per-turn timeouts (REQ-001) and the non-progress guard (REQ-016) surface a stalled worker within minutes rather than hours; and codex's system prompt (REQ-014) carries these pitfalls so it steers the worker to the verified path from the first turn.

---

## Implementation Roadmap

### Phase 1: Foundation (process, parsing, config)
**Goal:** Spawning, stream parsing, configuration, and auth hardening.

- [ ] Task 1.1: Subprocess wrapper (REQ-001) — Medium (5h) — Dependencies: none
- [ ] Task 1.2: NDJSON stream parser (REQ-002) — Small (3h) — Dependencies: none
- [ ] Task 1.3: Config load, path resolution, env sanitization, startup probe (REQ-012) — Medium (9h) — Dependencies: 1.1
- [ ] Task 1.4: Environment preflight + verified invocation script (REQ-019) — Small (8h) — Dependencies: 1.3 (codex-prompt pitfalls integrate with REQ-014 in Phase 3)

**Validation Checkpoint:** Startup probe confirms both agents respond under subscription auth with no API key in child env, and the preflight rejects the `python3` stub and the agent-SDK provider path.

### Phase 2: Worker and ground truth
**Goal:** Run a worker turn and observe real repository state.

- [ ] Task 2.1: Claude Code one-turn runner (REQ-003) — Medium (10h) — Dependencies: 1.1, 1.2
- [ ] Task 2.2: Ground-truth collector (REQ-004) — Medium (8h) — Dependencies: 1.1
- [ ] Task 2.3: Evidence digest builder (REQ-005) — Medium (8h) — Dependencies: 2.1, 2.2

**Validation Checkpoint:** A single worker turn produces a bounded digest that separates claims from facts.

### Phase 3: Supervisor and routing
**Goal:** codex decides; the orchestrator routes mechanically.

- [ ] Task 3.1: codex supervisor invocation with schema (REQ-006) — Medium (10h) — Dependencies: 2.3, 1.3
- [ ] Task 3.2: Verdict router (REQ-007) — Small (4h) — Dependencies: 3.1
- [ ] Task 3.3: Rolling memo store (REQ-009) — Small (5h) — Dependencies: none
- [ ] Task 3.4: codex system prompt and escalation whitelist (REQ-014) — Medium (4h) — Dependencies: 3.1

**Validation Checkpoint:** codex returns a schema-valid decision with cited evidence; codex performs no file writes.

### Phase 4: Loop, trunk, escalation, logging
**Goal:** Close the loop end-to-end.

- [ ] Task 4.1: Trunk wrapper for task-master (REQ-010) — Medium (7h) — Dependencies: 1.1
- [ ] Task 4.2: Per-turn control loop (REQ-008) — Medium (11h) — Dependencies: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1
- [ ] Task 4.3: Escalation channel (REQ-011) — Small (6h) — Dependencies: 4.2
- [ ] Task 4.4: Per-turn transcript logging and redaction (REQ-013) — Medium (8h) — Dependencies: none
- [ ] Task 4.5: Worker bootstrap prompt (REQ-015) — Small (2h) — Dependencies: 2.1

**Validation Checkpoint:** The loop advances across at least three tasks with human input only on escalations.

### Phase 5: Resilience and milestone verification
**Goal:** Guards, backoff, and the closed-loop proof.

- [ ] Task 5.1: Non-progress safety guard (REQ-016) — Small (3h) — Dependencies: 4.2, 4.3
- [ ] Task 5.2: Rate-limit and transient-failure backoff (REQ-017) — Medium (5h) — Dependencies: 2.1, 3.1
- [ ] Task 5.3: End-to-end milestone run with injected-fake and escalation drills — Medium (8h) — Dependencies: all prior

**Validation Checkpoint:** A logged run satisfies all v1 milestone criteria.

### Effort Estimation

- Phase 1: ~17h
- Phase 2: ~26h
- Phase 3: ~23h
- Phase 4: ~34h
- Phase 5: ~16h
- **Total: ~116 hours**, plus a 20% buffer (~23h) for unknowns ≈ **~140 hours**.

---

## Out of Scope

Explicitly NOT included in the first version:

1. **Single-process worker streaming via `--input-format stream-json`.** Reason: per-turn `--resume` is the confirmed mechanism; single long-lived streaming is a later optimization.
2. **codex as a persistent agent or codex-MCP driving the worker.** Reason: rejected during design in favor of the thin orchestrator; codex-MCP is experimental on Windows.
3. **Parallel or multi-worker execution and concurrent tasks.** Reason: the milestone proves a single sequential loop first.
4. **Automated git worktree management.** Reason: a single run assumes one writer; worktree automation is later.
5. **Rich escalation user experience (web, queue, asynchronous).** Reason: console plus optional desktop notification is sufficient for the milestone.
6. **Recovery beyond retry-once and escalate.** Reason: heuristic recovery adds risk without proving the core loop.
7. **Cost and quota dashboards.** Reason: usage is logged from result events; dashboards are later.
8. **Any deviation taxonomy (if/else handlers for deviation types) inside the orchestrator.** Reason: forbidden by the core design principle; codex handles deviations by reasoning.

---

## Open Questions & Risks

### Open Questions

#### Q1: How is task generation performed under the no-API-key constraint? (RESOLVED)
- **Current Status:** Resolved during this PRD's own task generation. task-master's `claude-code` provider blocks on this host (see Environment Constraints), and API-key providers are excluded by constraint. The verified path is to drive the `claude` CLI directly to produce the task breakdown and write `tasks.json`, then validate with `task-master list`. This path is to be captured by REQ-019.
- **Owner:** Project owner.
- **Impact:** Resolved — direct `claude` CLI invocation is the verified path; the agent-SDK provider is avoided.

#### Q2: Which permission posture should the worker run under?
- **Current Status:** Undecided between an allow-list with accept-edits and full skip-permissions in a sandbox.
- **Options:** (A) permission mode accept-edits plus an allow-list, (B) skip-permissions in a no-internet sandbox.
- **Owner:** Project owner.
- **Impact:** Medium — affects worker autonomy and isolation.

### Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation | Contingency |
|------|------------|--------|------------|-------------|
| codex output does not honor the schema | Medium | High | Local schema validation plus one re-ask | Escalate instead of guessing a verdict |
| Subscription usage cap reached mid-run | Medium | High | Bounded per-turn context; backoff | Escalate to pause or stop |
| OAuth token expiry mid-run | Medium | Medium | Rely on each agent's token refresh; retry the turn once | Escalate after repeated auth failures |
| Worker loops without progress | Medium | Medium | Non-progress counter that escalates | Human decides continue or abort |
| Windows `.cmd` spawn failure | Low | High | Centralized spawn via `cmd.exe /c` with array args | Fail immediately with a clear message |

---

## Validation Checkpoints

### Checkpoint 1: End of Phase 1
- [ ] Startup probe succeeds for both agents under subscription auth.
- [ ] Child-process environment contains no `*_API_KEY`.

### Checkpoint 2: End of Phase 2
- [ ] A worker turn yields a digest under the size cap that separates claims from facts.

### Checkpoint 3: End of Phase 3
- [ ] codex returns a schema-valid decision with at least one cited evidence item and performs no file writes.

### Checkpoint 4: End of Phase 4
- [ ] The loop advances across at least three tasks with human input only on escalations.
- [ ] An escalation pauses the run and routes the human answer back to codex.

### Checkpoint 5: v1 Milestone
- [ ] An injected false-"done" turn is caught with `fake_done_flag: true` and cited evidence, and the task is not marked done.
- [ ] A complete per-turn transcript exists for the whole run.
- [ ] Provider dashboards show 0 API usage.

---

## Appendix: Task Breakdown Hints

### Suggested Taskmaster Structure

**Foundation (3 tasks, ~17h)**
1. Subprocess wrapper with Windows `.cmd`/`.exe` handling and kill-tree (5h)
2. NDJSON stream parser tolerant of partial and non-JSON lines (3h)
3. Config, path resolution, env sanitization, and startup auth probe (9h)

**Worker & Ground Truth (3 tasks, ~26h)**
4. Claude Code one-turn runner with resume and stream normalization (10h)
5. Ground-truth collector for git diff/status and test exit code (8h)
6. Bounded evidence digest separating claims from facts (8h)

**Supervisor & Routing (4 tasks, ~23h)**
7. codex supervisor invocation with output schema and one retry (10h)
8. Verdict router as a pure switch (4h)
9. Rolling memo store with size bound (5h)
10. codex system prompt and escalation whitelist (4h)

**Loop, Trunk, Escalation, Logging (5 tasks, ~34h)**
11. Trunk wrapper for task-master next/show/set-status (7h)
12. Per-turn control loop with no deviation taxonomy (11h)
13. Escalation channel with console prompt and answer routing (6h)
14. Per-turn transcript logging and secret redaction (8h)
15. Worker bootstrap prompt (2h)

**Resilience & Milestone (3 tasks, ~16h)**
16. Non-progress safety guard (3h)
17. Rate-limit and transient-failure backoff (5h)
18. End-to-end milestone run with injected-fake and escalation drills (8h)

### Parallelizable Work

- Stream parser (2), memo store (9), and logging (14) have no cross dependencies and can proceed in parallel with other foundation work.
- Worker runner (4) and ground-truth collector (5) can proceed in parallel after the subprocess wrapper.

### Critical Path

Subprocess wrapper (1) → worker runner (4) and ground truth (5) → evidence digest (6) → codex supervisor (7) → router (8) → control loop (12) → milestone run (18).

**Critical path duration:** approximately 55 hours.

---

**End of PRD**

*This PRD is optimized for task-master AI task generation. Requirements include task breakdown hints, complexity estimates, priority labels, and dependency mapping.*
