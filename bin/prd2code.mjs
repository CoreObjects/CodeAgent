#!/usr/bin/env node
// prd2code — one command: PRD in → built code repo out, streaming the codex↔claude
// work live. All logic lives in src/cli.js; this is just the entry point.

import { runSuperv } from '../src/cli.js';

runSuperv({ argv: process.argv.slice(2) })
  .then((r) => {
    console.error(`\n[prd2code] ${r.reason}: repo at ${r.outDir}`);
    console.error(`[prd2code] per-turn transcript: ${r.runDir}`);
  })
  .catch((err) => {
    console.error(`[prd2code] ${err.message}`);
    process.exitCode = 1;
  });
