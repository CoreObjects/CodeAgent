import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { detectTestCommand } from '../src/detect-test.js';

// Zero-config test command: inspect a repo's marker files and return the command
// the supervisor should run for independent ground truth. Re-run each turn so it
// picks up the test setup as the worker builds it. null = no test yet (ground
// truth falls back to git only).

function tmp(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-'));
  setup(dir);
  return dir;
}

test('package.json with a test script -> npm test', () => {
  const dir = tmp((d) => fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } })));
  try {
    assert.deepEqual(detectTestCommand(dir), ['npm', 'test']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('package.json WITHOUT a test script does not map to npm test', () => {
  const dir = tmp((d) => fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x' })));
  try {
    assert.equal(detectTestCommand(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pyproject.toml -> python -m pytest', () => {
  const dir = tmp((d) => fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname="x"\n'));
  try {
    assert.deepEqual(detectTestCommand(dir), ['python', '-m', 'pytest', '-q']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tests/ dir with test_*.py -> pytest even without pyproject', () => {
  const dir = tmp((d) => {
    fs.mkdirSync(path.join(d, 'tests'));
    fs.writeFileSync(path.join(d, 'tests', 'test_x.py'), 'def test_x():\n    assert True\n');
  });
  try {
    assert.deepEqual(detectTestCommand(dir), ['python', '-m', 'pytest', '-q']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cargo.toml -> cargo test', () => {
  const dir = tmp((d) => fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname="x"\n'));
  try {
    assert.deepEqual(detectTestCommand(dir), ['cargo', 'test']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('go.mod -> go test ./...', () => {
  const dir = tmp((d) => fs.writeFileSync(path.join(d, 'go.mod'), 'module x\n'));
  try {
    assert.deepEqual(detectTestCommand(dir), ['go', 'test', './...']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty repo -> null (no test yet)', () => {
  const dir = tmp(() => {});
  try {
    assert.equal(detectTestCommand(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node takes precedence over an also-present python marker', () => {
  const dir = tmp((d) => {
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\n');
  });
  try {
    assert.deepEqual(detectTestCommand(dir), ['npm', 'test']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
