// Blizzard's UI source for each WoW Forever build, read from the public
// Gethe/wow-ui-source mirror (forever branch), by Squirt. All rights reserved.
import { get, readBody, request } from './http.mjs';
import { COLOURS, escapeMarkdown, fitLines } from './discord.mjs';

export const REPO = 'Gethe/wow-ui-source';
export const BRANCH = 'forever';
export const API = `https://api.github.com/repos/${REPO}`;
const WEB = `https://github.com/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const IGNORED = new Set(['version.txt', 'Interface/ui-code-list.txt']);
const FILE_CAP = 300; // GitHub lists at most 300 files per comparison
const PAGE = 300, PAGES = 10; // and up to 3000 files of one commit, 300 a page
const NAMESPACE_READS = 15;
const DOC = /\/Blizzard_APIDocumentationGenerated\/(\w+?)Documentation\.lua$/;
// What else changed in a doc, from its changed lines: secret or restriction
// flags, enum values, or argument, return and field types.
const TAGS = [
  ['secret', /\b(\w*Secret\w*|ChecksForbiddenAspects|RequiresValidAndPublicCVar)\b/],
  ['enum', /\bEnumValue = |^\t{3}(NumValues|MinValue|MaxValue) = /],
  ['types', /^\t{4}\{ Name = "\w+", Type = (?!.*\bEnumValue = )/],
];

export function githubHeaders(token, etag) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;
  return headers;
}

const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const firstLine = value => String(value ?? '').split('\n')[0].trim().slice(0, 100);
// "1.60.1 (70009)" gives 70009.
export const buildNumber = message => Number(String(message ?? '').match(/\((\d+)\)/)?.[1]) || null;
const buildLabel = commit => buildNumber(commit.message) || commit.sha.slice(0, 7);

// Functions and events in one side of a diff: a changed `Name = "X",` line at
// entry depth whose entry, on the same side, has Type "Function" or "Event".
// Events go by their LiteralName.
function entries(side) {
  const found = [];
  for (const [index, line] of side.entries()) {
    const name = line?.changed && line.text.match(/^\t\t\tName = "(\w+)",\s*$/)?.[1];
    if (!name) continue;
    let type = null, literal = null;
    for (let next = index + 1; next < side.length && next <= index + 8 && side[next]; next++) {
      const text = side[next].text;
      if (/^\t\t[{}]/.test(text)) break;
      type ||= text.match(/^\t\t\tType = "(\w+)",\s*$/)?.[1];
      literal ||= text.match(/^\t\t\tLiteralName = "(\w+)",\s*$/)?.[1];
    }
    if (type === 'Function') found.push({ index, name });
    if (type === 'Event') found.push({ index, name: literal || name });
  }
  return found;
}

// Changed lines on one side of a diff outside the entries named in `names`
// (a new function brings its own argument and secret lines).
function otherLines(side, found, names) {
  const skip = new Set();
  for (const { index } of found.filter(entry => names.includes(entry.name))) {
    for (let next = index; next < side.length && side[next]; next++) {
      skip.add(next);
      if (/^\t\t\}/.test(side[next].text)) break;
    }
  }
  return side.filter((line, index) => line?.changed && !skip.has(index)).map(line => line.text);
}

// Functions and events added or removed in one API documentation diff, and
// what else changed (see TAGS). Each hunk is split into its old and new side,
// so a name whose Type line didn't change still counts. Anything on both sides
// (moved or edited) is left out of the names.
export function apiChanges(patch) {
  const oldSide = [], newSide = [];
  let namespace = null;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('@@')) { oldSide.push(null); newSide.push(null); continue; }
    const mark = line[0], text = line.slice(1);
    namespace ||= text.match(/^\tNamespace = "(\w+)",/)?.[1] || null;
    if (mark === '-') oldSide.push({ text, changed: true });
    else if (mark === '+') newSide.push({ text, changed: true });
    else if (mark === ' ') { oldSide.push({ text, changed: false }); newSide.push({ text, changed: false }); }
  }
  const newEntries = entries(newSide), oldEntries = entries(oldSide);
  const newNames = newEntries.map(entry => entry.name), oldNames = oldEntries.map(entry => entry.name);
  const added = newNames.filter(name => !oldNames.includes(name));
  const removed = oldNames.filter(name => !newNames.includes(name));
  const rest = [...otherLines(oldSide, oldEntries, removed), ...otherLines(newSide, newEntries, added)];
  const tags = TAGS.filter(([, pattern]) => rest.some(line => pattern.test(line))).map(([tag]) => tag);
  return { namespace, added, removed, tags };
}

export const docTags = patch => apiChanges(patch).tags;

// "Interface/AddOns/Blizzard_ActionBar/x.lua" becomes "ActionBar/x.lua".
const shortPath = path => path.replace(/^Interface\/AddOns\//, '').replace(/^Blizzard_/, '');

// `capped`: GitHub stopped listing files, so every count is only for the
// files it listed.
export function summariseFiles(files, capped = files.length >= FILE_CAP) {
  const kept = files.filter(file => typeof file?.filename === 'string' && !IGNORED.has(file.filename));
  const addons = new Set(), api = [], quiet = [], changedFiles = [];
  let additions = 0, deletions = 0;
  for (const file of kept) {
    additions += Number(file.additions) || 0;
    deletions += Number(file.deletions) || 0;
    const addon = file.filename.match(/^Interface\/AddOns\/([^/]+)\//)?.[1];
    if (addon) addons.add(addon);
    const doc = file.filename.match(DOC)?.[1];
    if (doc) {
      const changes = apiChanges(file.patch);
      if (file.status === 'added' || file.status === 'removed' || changes.added.length || changes.removed.length) {
        // A new doc's diff is the whole file, so no Namespace line means globals.
        const global = file.status === 'added' && Boolean(file.patch) && !changes.namespace;
        api.push({ name: doc, path: file.filename, status: file.status, ...changes, global });
      } else {
        quiet.push({ name: doc, tags: changes.tags });
      }
    } else if (['added', 'removed', 'renamed'].includes(file.status)) {
      changedFiles.push({ status: file.status, path: shortPath(file.filename), from: file.previous_filename && shortPath(file.previous_filename) });
    }
  }
  const order = { added: 0, removed: 1 };
  api.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
  return {
    files: kept.length, listed: files.length, capped, additions, deletions,
    addons: [...addons].sort(), api, quiet, changedFiles,
  };
}

// The namespace of each changed doc shown by name, read from the file itself
// on raw.githubusercontent.com (no API rate limit), because a diff rarely
// includes it. No namespace means globals. One that can't be read keeps its
// file name.
async function readNamespaces(api, sha, { fetcher, sleep }) {
  const unknown = api.filter(doc => !doc.namespace && !doc.global && doc.status !== 'removed' && doc.path);
  for (const doc of unknown.slice(0, NAMESPACE_READS)) {
    try {
      const path = doc.path.split('/').map(encodeURIComponent).join('/');
      const text = await get(`${RAW}/${sha}/${path}`, 'GitHub', { json: false, fetcher, sleep, tries: 2 });
      doc.namespace = String(text).match(/^\tNamespace = "(\w+)",/m)?.[1] || null;
      doc.global = !doc.namespace;
    } catch { /* keeps the file name */ }
  }
}

// Every file of one commit, a page at a time.
async function commitFiles(sha, options) {
  const files = [];
  for (let page = 1; page <= PAGES; page++) {
    const commit = await get(`${API}/commits/${sha}?per_page=${PAGE}&page=${page}`, 'GitHub', options);
    if (!Array.isArray(commit?.files)) throw new Error('GitHub: unexpected commit');
    files.push(...commit.files);
    if (commit.files.length < PAGE) break;
  }
  return files;
}

// The changes between the saved commit and the newest one: a comparison when
// the saved commit is still behind it, otherwise the newest commit alone. A
// comparison lists at most 300 files; for a single new commit the full list
// comes from the commit itself.
async function findDiff(base, head, { token, fetcher, sleep }) {
  const options = { headers: githubHeaders(token), missing: [404], fetcher, sleep };
  const compare = await get(`${API}/compare/${base.sha}...${head.sha}`, 'GitHub', options);
  let diff;
  if (compare?.status === 'ahead' && Array.isArray(compare.files)) {
    const commits = Array.isArray(compare.commits) ? compare.commits : [];
    const whole = compare.files.length >= FILE_CAP && commits.length === 1;
    const files = whole ? await commitFiles(head.sha, { ...options, missing: [] }) : compare.files;
    const newer = message => !buildNumber(message) || !base.top || buildNumber(message) > base.top;
    diff = {
      builds: [...new Set(commits.map(commit => firstLine(commit?.commit?.message)).filter(Boolean).filter(newer))],
      summary: summariseFiles(files, whole ? files.length >= PAGE * PAGES : files.length >= FILE_CAP),
      url: `${WEB}/compare/${base.sha.slice(0, 12)}...${head.sha.slice(0, 12)}`,
      linkText: `Compare ${buildLabel(base)}...${buildLabel(head)}`,
    };
  } else {
    const files = await commitFiles(head.sha, { ...options, missing: [] });
    diff = {
      builds: [head.message],
      summary: summariseFiles(files, files.length >= PAGE * PAGES),
      url: `${WEB}/commit/${head.sha}`,
      linkText: `View commit ${head.sha.slice(0, 7)}`,
      note: 'The forever branch history changed, so this shows the newest commit only.',
    };
  }
  await readNamespaces(diff.summary.api, head.sha, { fetcher, sleep });
  return diff;
}

// The saved commit, commit message and ETag only move forward once the whole
// check has worked, so a failure is simply tried again next run. `top` is the
// highest build number seen: the mirror sometimes goes back to an older build
// for a while, which isn't posted, and the saved commit stays on the newest
// build, so the next new build is compared with that.
export async function checkUiSource(previous, { token = null, fetcher, sleep } = {}) {
  const known = isSha(previous?.sha) ? previous : null;
  const response = await request(`${API}/commits?sha=${BRANCH}&per_page=20`, {
    label: 'GitHub', headers: githubHeaders(token, known?.etag), fetcher, sleep,
  });
  if (known && response.status === 304) return { entry: known, kind: 'same' };
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
  const commits = await readBody(response, 'GitHub');
  if (!Array.isArray(commits) || !isSha(commits[0]?.sha)) throw new Error('GitHub: unexpected commit list');
  const head = commits[0];
  const entry = {
    sha: head.sha, message: firstLine(head.commit?.message), etag: response.headers.get('etag') || null,
    date: head.commit?.committer?.date || null,
  };
  const build = buildNumber(entry.message);
  if (!known) return { entry: { ...entry, top: build }, first: true };
  const top = Math.max(known.top || 0, buildNumber(known.message) || 0) || null;
  if (head.sha === known.sha) return { entry: { ...entry, top }, kind: 'same' };
  if (build && top && build <= top) return { entry: { ...known, etag: entry.etag, top }, kind: 'older', head: entry };
  const base = { ...known, top };
  const next = { ...entry, top: Math.max(build || 0, top || 0) || null };
  return { entry: next, kind: 'new', event: { base, head: entry, ...(await findDiff(base, entry, { token, fetcher, sleep })) } };
}

function nameList(names, cap = 10) {
  const shown = names.slice(0, cap).join(', ');
  return names.length > cap ? `${shown}, +${names.length - cap} more` : shown;
}

// Docs that go with a watched addon: "CooldownViewer" also matches
// CooldownViewerConstants, and "TrainerUI" matches Trainer.
const watchBases = watch => watch.map(name => name.toLowerCase().replace(/^blizzard_/, '').replace(/ui$/, '')).filter(Boolean);
const watchedDoc = (name, bases) => bases.some(base => name.toLowerCase().startsWith(base));
const bold = (text, on) => (on ? `**${text}**` : text);

function apiLine(doc, bases) {
  const name = doc.namespace || (doc.global ? `${doc.name} (global)` : doc.name);
  const label = bold(escapeMarkdown(name), watchedDoc(doc.name, bases));
  const also = doc.tags?.length ? ` (also ${doc.tags.join(', ')})` : '';
  if (doc.status === 'added') return `• New ${label}${doc.added.length ? `: ${nameList(doc.added.map(escapeMarkdown))}` : ''}`;
  if (doc.status === 'removed') return `• Removed ${label}`;
  return `• ${label}: ${nameList([...doc.added.map(name => `+${escapeMarkdown(name)}`), ...doc.removed.map(name => `-${escapeMarkdown(name)}`)])}${also}`;
}

// Named changes first (docs for watched addons at the top), then every other
// changed doc by name with what kind of change it has.
function apiText({ api, quiet }, watch, room) {
  const bases = watchBases(watch);
  const rank = doc => (watchedDoc(doc.name, bases) ? 0 : 1);
  const named = [...api].sort((a, b) => rank(a) - rank(b)).map(doc => apiLine(doc, bases));
  const others = [...quiet].sort((a, b) => rank(a) - rank(b) || (b.tags.length ? 1 : 0) - (a.tags.length ? 1 : 0))
    .map(doc => `${bold(escapeMarkdown(doc.name), watchedDoc(doc.name, bases))}${doc.tags.length ? ` (${doc.tags.join(', ')})` : ''}`);
  const also = others.length ? `• Also changed: ${fitLines(others, 1000, count => `+${count} more`, ', ')}` : '';
  return [fitLines(named, room - also.length - 1), also].filter(Boolean).join('\n');
}

function fileLine({ status, path, from }) {
  if (status === 'added') return `+ ${escapeMarkdown(path)}`;
  if (status === 'removed') return `\\- ${escapeMarkdown(path)}`;
  return `${escapeMarkdown(from || '?')} → ${escapeMarkdown(path)}`;
}

// Addons on the watch list come first, in bold.
function addonList(addons, watch = []) {
  const wanted = new Set(watch.map(name => name.toLowerCase().replace(/^blizzard_/, '')));
  const names = addons.map(addon => addon.replace(/^Blizzard_/, ''));
  const watched = names.filter(name => wanted.has(name.toLowerCase()));
  const rest = names.filter(name => !wanted.has(name.toLowerCase()));
  const items = [...watched.map(name => `**${escapeMarkdown(name)}**`), ...rest.map(escapeMarkdown)];
  return fitLines(items, 1024, count => `+${count} more`, ', ');
}

export function uiEmbed({ head, builds, summary, url, linkText, note }, { watch = [] } = {}) {
  const lines = `+${summary.additions} / -${summary.deletions} lines`;
  const count = summary.capped
    ? `${summary.listed}+ files, ${lines} in the first ${summary.listed} (GitHub lists no more, so all counts here are partial).`
    : `${summary.files} ${summary.files === 1 ? 'file' : 'files'}, ${lines}.`;
  const top = [`${count} [${escapeMarkdown(linkText)}](${url})`];
  if (builds.length > 1) top.push(`Covers ${builds.map(escapeMarkdown).join(', ')}.`);
  if (note) top.push(note);
  let description = top.join('\n');
  if (summary.api.length || summary.quiet.length) description += `\n\n**API changes**\n${apiText(summary, watch, 3200 - description.length)}`;
  const fields = [];
  if (summary.addons.length) {
    fields.push({ name: `Blizzard addons changed (${summary.addons.length}${summary.capped ? '+' : ''})`, value: addonList(summary.addons, watch) });
  }
  if (summary.changedFiles.length) {
    fields.push({ name: `Files added or removed${summary.capped ? ' (partial)' : ''}`, value: fitLines(summary.changedFiles.map(fileLine), 1024) });
  }
  return {
    title: `UI source for ${head.message || head.sha.slice(0, 7)}`,
    url,
    color: COLOURS.ui,
    description,
    fields,
    footer: { text: `${REPO}, ${BRANCH} branch` },
    ...(head.date ? { timestamp: head.date } : {}),
  };
}
