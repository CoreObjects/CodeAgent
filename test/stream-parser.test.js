import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonParser } from '../src/stream-parser.js';

// REQ-002: line-buffered NDJSON parser feeding the Claude Code stream-json consumer.

test('parses a single complete JSON line', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"type":"a","n":1}\n'), [
    { type: 'json', value: { type: 'a', n: 1 } },
  ]);
});

test('a JSON object split across two chunks is parsed once both arrive (2.1)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"a":'), []); // no newline yet -> nothing emitted
  assert.deepEqual(p.push('1}\n'), [{ type: 'json', value: { a: 1 } }]);
});

test('retains a partial trailing line across chunks until flush (2.1)', () => {
  const p = new NdjsonParser();
  // second object is complete but has no trailing newline yet -> stays buffered
  assert.deepEqual(p.push('{"a":1}\n{"b":2}'), [{ type: 'json', value: { a: 1 } }]);
  assert.deepEqual(p.flush(), [{ type: 'json', value: { b: 2 } }]);
});

test('emits multiple complete objects from one chunk in order (2.1)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"a":1}\n{"b":2}\n'), [
    { type: 'json', value: { a: 1 } },
    { type: 'json', value: { b: 2 } },
  ]);
});

test('CRLF lines parse identically to LF — carriage return stripped (2.2)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"a":1}\r\n'), [{ type: 'json', value: { a: 1 } }]);
});

test('a non-JSON line is routed to the raw channel without throwing (2.3)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('this is not json\n'), [
    { type: 'raw', line: 'this is not json' },
  ]);
});

test('mixes json and garbage lines, preserving order (2.3)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"ok":1}\noops {not valid\n{"ok":2}\n'), [
    { type: 'json', value: { ok: 1 } },
    { type: 'raw', line: 'oops {not valid' },
    { type: 'json', value: { ok: 2 } },
  ]);
});

test('blank and CR-only lines are skipped (no raw noise)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('\n\r\n'), []);
});

test('flush on an empty buffer yields nothing', () => {
  const p = new NdjsonParser();
  p.push('{"a":1}\n');
  assert.deepEqual(p.flush(), []);
});

test('flush parses a final line that had no trailing newline', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"a":1}'), []);
  assert.deepEqual(p.flush(), [{ type: 'json', value: { a: 1 } }]);
});
