// Forever tracker saved state, by Squirt. All rights reserved.
// One small JSON file that GitHub Actions keeps between runs in its cache.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const STATE_VERSION = 1;

export function emptyState() {
  return { v: STATE_VERSION, startedAt: null, builds: {}, ui: null, forum: null, outbox: [], health: {} };
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Anything missing or malformed falls back to its empty value, so a damaged
// part only resets that part.
export function normaliseState(saved) {
  const state = emptyState();
  if (!isObject(saved) || saved.v !== STATE_VERSION) return state;
  if (typeof saved.startedAt === 'string') state.startedAt = saved.startedAt;
  if (isObject(saved.builds)) state.builds = saved.builds;
  if (isObject(saved.ui)) state.ui = saved.ui;
  if (isObject(saved.forum)) state.forum = saved.forum;
  if (Array.isArray(saved.outbox)) state.outbox = saved.outbox.filter(item => isObject(item) && item.key && isObject(item.payload));
  if (isObject(saved.health)) state.health = saved.health;
  return state;
}

// A missing file gives null: a first run, a lost state, or a cache that
// failed to restore (the tracker tells these apart). An unreadable file starts
// again from nothing.
export async function loadState(file, log = console.log) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return normaliseState(JSON.parse(text));
  } catch {
    log('Saved state is unreadable; starting again.');
    return emptyState();
  }
}

// Written to a temporary file first, so a crash never leaves half a file.
export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 1)}\n`);
  await rename(temporary, file);
}
