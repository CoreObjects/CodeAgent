// project-map.js — Phase 1 (v3)
// A bounded, every-turn PROJECT MAP that gives codex the global awareness the
// single-task evidence digest lacks: the repo layout, per-task status, and
// codex's own accumulated integration notes. Pure rendering; collecting the
// inputs (git ls-files, tasks.json) is the caller's job (see collectProjectMap).
//
// Cheap by design — bounded like the digest — so it can ride along every turn.
// codex's deep, firsthand look at the repo happens separately at integration
// checkpoints / acceptance (the "review" invocation), not here.

import fs from 'node:fs';
import path from 'node:path';
import { runProcess as defaultRunProcess } from './proc.js';

function topDir(file) {
  const i = String(file).indexOf('/');
  return i === -1 ? '.' : file.slice(0, i);
}

/** Collect the map inputs from a repo: tracked files (git ls-files) + tasks.json. */
export async function collectProjectMap({ cwd, runProcess = defaultRunProcess, notes = '', caps } = {}) {
  const ls = await runProcess('git', ['ls-files'], { cwd });
  const files = (ls.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let tasks = [];
  try {
    const tj = JSON.parse(fs.readFileSync(path.join(cwd, '.taskmaster', 'tasks', 'tasks.json'), 'utf8'));
    tasks = (tj.master?.tasks ?? []).map((t) => ({ id: String(t.id), title: t.title, status: t.status }));
  } catch {
    /* no tasks yet */
  }
  return buildProjectMap({ files, tasks, notes, caps });
}

/**
 * @param {{files?:string[], tasks?:Array<{id:string,title?:string,status?:string}>, notes?:string,
 *          caps?:{maxFiles?:number,maxTasks?:number,notesChars?:number}}} [opts]
 * @returns {string}
 */
export function buildProjectMap({ files = [], tasks = [], notes = '', caps = {} } = {}) {
  const { maxFiles = 40, maxTasks = 30, notesChars = 1500 } = caps;

  const byDir = {};
  for (const f of files) {
    const d = topDir(f);
    byDir[d] = (byDir[d] || 0) + 1;
  }
  const layout = Object.entries(byDir)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d}/ (${n})`)
    .join('  ');

  const fileLines =
    files.slice(0, maxFiles).join('\n') + (files.length > maxFiles ? `\n… +${files.length - maxFiles} more` : '');

  const done = tasks.filter((t) => t.status === 'done').length;
  const mark = (s) => (s === 'done' ? 'x' : s === 'in-progress' ? '>' : ' ');
  const taskLines =
    tasks
      .slice(0, maxTasks)
      .map((t) => `[${mark(t.status)}] ${t.id} ${t.title ?? ''}`.trimEnd())
      .join('\n') + (tasks.length > maxTasks ? `\n… +${tasks.length - maxTasks} more` : '');

  const cappedNotes = notes.length > notesChars ? `${notes.slice(0, notesChars)}…` : notes;

  return [
    '### PROJECT MAP',
    `Layout: ${layout || '(empty)'}`,
    `Files (${files.length}):`,
    fileLines || '(none)',
    `Tasks (done ${done}/${tasks.length}):`,
    taskLines || '(none)',
    notes ? `Integration notes:\n${cappedNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
