// memo-store.js — REQ-009
// Persist codex's rolling memo byte-for-byte and replay it verbatim next turn.
// The memo is codex's own working memory — we never author or edit its content.
// On overflow we WARN and pass it through (codex self-compacts); we never silently
// truncate, which would corrupt its memory.

import fs from 'node:fs';

/**
 * @param {{path:string, maxChars?:number, onWarn?:(msg:string)=>void}} opts
 */
export function createMemoStore({ path, maxChars = 6000, onWarn = () => {} }) {
  return {
    /** Read the persisted memo, or '' if none exists yet. */
    read() {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    },

    /** Write the memo exactly as codex returned it. Returns its length. */
    write(memo) {
      const s = String(memo ?? '');
      if (s.length > maxChars) {
        onWarn(
          `rolling memo exceeds cap: ${s.length} > ${maxChars} chars — passing through; codex should self-compact`,
        );
      }
      fs.writeFileSync(path, s, 'utf8'); // byte-for-byte; never truncated
      return s.length;
    },
  };
}
