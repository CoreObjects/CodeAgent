// reporter.js
// The live console reporter — it streams what the worker (claude) does and what
// the supervisor (codex) decides to the screen as the run progresses, so the user
// watches the codex↔claude interaction in real time. Pure rendering: it writes to
// an injected stream and makes no decisions.
//
//   taskStart  ── ━━ Task 3/12: <title> ━━
//   workerEvent ── streamed claude stream-json events (text + tool_use bullets)
//   turn       ── ground truth + codex verdict + the message relayed to claude
//   done       ── final reason + turn count

const RULE = '━'.repeat(56);

function targetOf(name, input = {}) {
  if (input.file_path) return input.file_path;
  if (input.command) return input.command;
  if (input.pattern) return input.pattern;
  if (input.path) return input.path;
  return '';
}

function clip(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/**
 * @param {{out?: {write:(s:string)=>void}, quiet?: boolean}} [opts]
 */
export function createConsoleReporter({ out = process.stdout, quiet = false } = {}) {
  const w = (s) => out.write(s);

  return {
    taskStart({ task, index, total }) {
      const title = task?.title ?? task?.id ?? '';
      w(`\n${RULE}\n━━ Task ${index}/${total}: ${title}\n${RULE}\n`);
    },

    // A single normalized claude stream-json event, rendered live.
    workerEvent(ev) {
      if (quiet || !ev) return;
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) w(`  ${clip(block.text, 500)}\n`);
          else if (block.type === 'tool_use') {
            const tgt = clip(targetOf(block.name, block.input), 120);
            w(`  · ${block.name}${tgt ? ` ${tgt}` : ''}\n`);
          }
        }
      } else if (ev.type === 'user') {
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'tool_result' && block.is_error === true) w(`    ✗ tool error\n`);
        }
      }
    },

    turn({ turnIndex, groundTruth = {}, decision = {} }) {
      const changed = groundTruth.changedFiles ?? [];
      const test = groundTruth.test;
      const facts =
        `    facts: ${changed.length} file(s) changed` +
        (changed.length ? ` [${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ', …' : ''}]` : '') +
        (test ? `, test exit ${test.exitCode}` : '');
      w(`${facts}\n`);

      const fake = decision.fake_done_flag ? ' ⚑fake-done' : '';
      w(`  👁 codex: ${decision.verdict ?? '?'}${fake}\n`);
      if (decision.assessment) w(`     ${clip(decision.assessment, 300)}\n`);
      if (decision.verdict === 'escalate' && decision.escalation_question) {
        w(`     ⛔ ${clip(decision.escalation_question, 300)}\n`);
      } else if (decision.message_to_claude) {
        w(`     → ${clip(decision.message_to_claude, 300)}\n`);
      }
    },

    escalation({ question }) {
      w(`\n⛔ ESCALATION: ${clip(question, 400)}\n`);
    },

    done({ reason, turns }) {
      w(`\n${RULE}\n✓ finished: ${reason} after ${turns} turn(s)\n${RULE}\n`);
    },
  };
}
