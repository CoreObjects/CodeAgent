// stream-parser.js — REQ-002
// Line-buffered NDJSON parser for the Claude Code stream-json output.
//
// Each completed line becomes one event:
//   { type: 'json', value }  — line parsed as JSON
//   { type: 'raw',  line  }  — line was not JSON (diagnostics, leaked prompts);
//                              surfaced instead of thrown so a run never crashes.
//
// Semantics that downstream (REQ-003 session-id capture) depends on:
//   - a JSON object split across chunk boundaries is emitted only once its
//     newline arrives (partial trailing line is retained in the buffer);
//   - carriage returns are stripped at the parse step, not in the buffer, so
//     CRLF streams from the Windows claude.cmd shim parse identically to LF.

export class NdjsonParser {
  constructor() {
    /** @type {string} bytes received but not yet terminated by a newline */
    this.buffer = '';
  }

  /**
   * Feed a chunk of stream text. Returns events for every line completed by a
   * newline in this chunk (possibly empty). The trailing partial line stays
   * buffered for the next push()/flush().
   * @param {string} chunk
   */
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const ev = this.#parseLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /**
   * Flush any buffered final line that arrived without a trailing newline.
   * Call once at end of stream.
   */
  flush() {
    if (this.buffer.length === 0) return [];
    const line = this.buffer;
    this.buffer = '';
    const ev = this.#parseLine(line);
    return ev ? [ev] : [];
  }

  // Strip a trailing CR for the parse only (the buffer keeps raw bytes), skip
  // blank lines, and fall back to the raw channel on non-JSON.
  #parseLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return null;
    try {
      return { type: 'json', value: JSON.parse(line) };
    } catch {
      return { type: 'raw', line };
    }
  }
}
