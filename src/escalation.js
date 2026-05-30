// escalation.js — REQ-011
// The human escalation channel. On a codex `escalate` verdict the loop calls
// askHuman(question); this module presents the question in a delimited console
// block, BLOCKS on one line of typed input, optionally fires a best-effort
// desktop notification (degrading silently when unavailable), records the
// exchange for the transcript, and returns the typed answer verbatim.
//
// It makes NO decision. Routing the answer back to codex (never to the worker)
// is the loop's job — this module only relays the human's words. Streams and the
// notifier/recorder are injected so the channel is fully testable without a TTY.

import readline from 'node:readline';

const DELIM = '─'.repeat(60);

/** Render codex's question inside a clearly delimited console block. */
export function formatEscalationBlock(question) {
  return [
    '',
    DELIM,
    '⛔ SUPERVISOR ESCALATION — human decision needed',
    DELIM,
    String(question),
    DELIM,
    '',
  ].join('\n');
}

/**
 * @param {{
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   notify?: ((n:{title:string,message:string}) => void) | null,
 *   record?: ((e:{question:string,answer:string}) => void) | null,
 * }} [opts]
 * @returns {{ askHuman: (question:string) => Promise<string> }}
 */
export function createEscalationChannel({
  input = process.stdin,
  output = process.stdout,
  notify = null,
  record = null,
} = {}) {
  async function askHuman(question) {
    // Best-effort desktop notification — must never break the pause.
    if (notify) {
      try {
        notify({ title: 'Supervisor escalation', message: String(question) });
      } catch {
        /* degrade to console-only */
      }
    }

    output.write(formatEscalationBlock(question));
    output.write('Your answer (one line, Enter to submit): ');

    const line = await new Promise((resolve) => {
      const rl = readline.createInterface({ input, output, terminal: false });
      rl.once('line', (l) => {
        rl.close();
        resolve(l);
      });
    });

    const answer = line.replace(/\r$/, ''); // strip a stray CR (Windows CRLF)

    // Recording must not break the pause either.
    if (record) {
      try {
        record({ question, answer });
      } catch {
        /* transcript best-effort */
      }
    }

    return answer;
  }

  return { askHuman };
}
