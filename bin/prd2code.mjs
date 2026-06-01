#!/usr/bin/env node
// prd2code — one command: PRD in → built code repo out, streaming the codex↔claude
// work live. All logic lives in src/cli.js; this is just the entry point.

import { runCli } from '../src/cli.js';

runCli({ argv: process.argv.slice(2) })
  .then((r) => {
    if (r?.outDir) {
      console.error(`\n[prd2code] ${r.reason}: repo at ${r.outDir}`);
      if (r.runDir) console.error(`[prd2code] per-turn transcript: ${r.runDir}`);
    }
    if (r && r.ok === false) process.exitCode = 1; // doctor/login/docs not-ready
  })
  .catch((err) => {
    console.error(`[prd2code] ${err.message}`);
    process.exitCode = 1;
  });
