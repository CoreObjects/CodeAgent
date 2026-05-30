# Verified host pitfalls (REQ-019 → inlined into the codex system prompt, REQ-014)

This record mirrors `src/preflight.js` `PITFALLS` (single source of truth). The
supervisor must steer the worker to the verified path **from the first turn**
instead of letting it rediscover these the hard way.

- `python3` is the Microsoft Store stub (exit 49, no output) -> use `python` (real CPython 3.10.7)
- host locale is GBK; Python decodes UTF-8 files as GBK and crashes -> set PYTHONUTF8=1 for any UTF-8-reading script
- the CLI is `task-master` (hyphenated); a `taskmaster` lookup does not resolve -> invoke `task-master`
- driving codex/claude via the `.cmd` node shim is slow (~98s) and triggers a model-refresh timeout -> resolve and run the vendored native `.exe`
- `codex exec` blocks reading stdin until EOF -> pipe the evidence digest to codex stdin, or close stdin
- task-master `claude-code` provider hangs (agent-SDK never spawns a worker, >16 min) -> drive the `claude` CLI directly to generate tasks
