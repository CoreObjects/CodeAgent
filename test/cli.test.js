import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugFromPrd, parseSupervArgs } from '../src/cli.js';

// Pure CLI helpers. The IO-heavy runSuperv (scaffold + decompose + run) is
// covered by the live smoke (`superv docs/test-prd.md --limit 3`), not unit tests.

test('slugFromPrd derives a clean slug from the PRD H1, stripping a PRD: prefix and trailing detail', () => {
  const prd = '# PRD: CasioCalc — Casio fx-82ES PLUS 风格科学计算器（桌面版）\n\nbody...';
  assert.equal(slugFromPrd(prd, 'test-prd'), 'casiocalc');
});

test('slugFromPrd slugifies a plain title', () => {
  assert.equal(slugFromPrd('# Simple Title Here', 'x'), 'simple-title-here');
});

test('slugFromPrd falls back to the file name when there is no H1', () => {
  assert.equal(slugFromPrd('no heading at all', 'my-prd'), 'my-prd');
});

test('parseSupervArgs: just a PRD path uses zero-config defaults', () => {
  const o = parseSupervArgs(['./prd.md']);
  assert.equal(o.prd, './prd.md');
  assert.equal(o.out, null);
  assert.equal(o.decompose, true);
  assert.equal(o.limit, 0);
  assert.equal(o.quiet, false);
  assert.equal(o.test, null);
});

test('parseSupervArgs: flags are parsed and --test is split into argv', () => {
  const o = parseSupervArgs(['./prd.md', '--out', './x', '--limit', '3', '--quiet', '--no-decompose', '--test', 'npm test', '--num', '5 to 8']);
  assert.equal(o.out, './x');
  assert.equal(o.limit, 3);
  assert.equal(o.quiet, true);
  assert.equal(o.decompose, false);
  assert.deepEqual(o.test, ['npm', 'test']);
  assert.equal(o.num, '5 to 8');
});

test('parseSupervArgs: a second positional is the target dir', () => {
  const o = parseSupervArgs(['./prd.md', './target']);
  assert.equal(o.prd, './prd.md');
  assert.equal(o.out, './target');
});
