import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoStore } from '../src/memo-store.js';

// REQ-009: rolling memo store — byte-for-byte persistence, size cap WARNS (never truncates).

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-'));
  return Promise.resolve(fn(path.join(dir, 'memo.md'))).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true }),
  );
}

test('writes and reads a memo byte-for-byte (unicode + whitespace preserved)', () =>
  withTmp((file) => {
    const store = createMemoStore({ path: file });
    const memo = '  线索:\n  - 任务A 未完成\t(注意)\n';
    store.write(memo);
    assert.equal(store.read(), memo);
  }));

test('read returns empty string when no memo exists yet', () =>
  withTmp((file) => {
    assert.equal(createMemoStore({ path: file }).read(), '');
  }));

test('over-cap memo WARNS but is NOT truncated (codex self-compacts)', () =>
  withTmp((file) => {
    let warned = null;
    const store = createMemoStore({ path: file, maxChars: 10, onWarn: (m) => (warned = m) });
    const big = 'x'.repeat(50);
    const len = store.write(big);
    assert.ok(warned, 'expected an overflow warning');
    assert.equal(len, 50);
    assert.equal(store.read(), big); // full content preserved, not truncated
  }));

test('under-cap memo does not warn', () =>
  withTmp((file) => {
    let warned = null;
    const store = createMemoStore({ path: file, maxChars: 6000, onWarn: (m) => (warned = m) });
    store.write('short');
    assert.equal(warned, null);
  }));
