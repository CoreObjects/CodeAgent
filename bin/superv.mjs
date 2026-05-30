#!/usr/bin/env node
// superv — one command: PRD in → built code repo out, streaming the codex↔claude
// work live. All logic lives in src/cli.js; this is just the entry point.

import { runSuperv } from '../src/cli.js';

runSuperv({ argv: process.argv.slice(2) })
  .then((r) => {
    console.error(`\n[superv] ${r.reason}: repo at ${r.outDir}`);
    console.error(`[superv] per-turn transcript: ${r.runDir}`);
  })
  .catch((err) => {
    console.error(`[superv] ${err.message}`);
    process.exitCode = 1;
  });
