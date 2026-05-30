#!/usr/bin/env node
// scripts/milestone.mjs — demo wrapper. Now just runs the real product CLI on the
// sample PRD; equivalent to `superv docs/test-prd.md`. Kept for muscle memory.
//
//   node scripts/milestone.mjs [--limit 3] [--quiet] [...superv flags]
//
// Zero config: superv scaffolds the repo, auto-detects the test command, and the
// worker installs its own deps. Spends subscription quota; Ctrl-C anytime.

import { runSuperv } from '../src/cli.js';

const extra = process.argv.slice(2);

runSuperv({ argv: ['docs/test-prd.md', ...extra] })
  .then((r) => {
    console.error(`\n[milestone] ${r.reason}: repo at ${r.outDir}`);
    console.error(`[milestone] transcript: ${r.runDir}`);
  })
  .catch((err) => {
    console.error(`[milestone] ${err.message}`);
    process.exitCode = 1;
  });
