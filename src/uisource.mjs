// Blizzard's UI source for each WoW Forever build, read from the public
// Gethe/wow-ui-source mirror (forever branch), by Squirt. All rights reserved.
import { get, readBody, request } from './http.mjs';
import { COLOURS, escapeMarkdown, fitLines } from './discord.mjs';

export const REPO = 'Gethe/wow-ui-source';
export const BRANCH = 'forever';
export const API = `https://api.github.com/repos/${REPO}`;
const WEB = `https://github.com/${REPO}`;
const IGNORED = new Set(['version.txt', 'Interface/ui-code-list.txt']);
const FILE_CAP = 300; // GitHub lists at most 300 files per comparison
const DOC = /\/Blizzard_APIDocumentationGenerated\/(\w+?)Documentation\.lua$/;

export function githubHeaders(token, etag) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;
  return headers;
}

const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const firstLine = value => String(value ?? '').split('\n')[0].trim().slice(0, 100);
// "1.60.1 (70009)" gives 70009; anything else gives the short sha.
const buildLabel = commit => commit.message?.match(/\((\d+)\)/)?.[1] || commit.sha.slice(0, 7);

// Function and event names in one side of a diff: a changed `Name = "X",` line
// at entry depth whose entry, on the same side, has Type "Function" or "Event".
function entryNames(side) {
  const names = [];
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
    if (type === 'Function') names.push(name);
    if (type === 'Event') names.push(literal || name);
  }
  return names;
}

// Functions and events added or removed in one API documentation diff. Each
// hunk is split into its old and new side, so a name whose Type line didn't
// change still counts. Anything on both sides (moved or edited) is left out.
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
  const added = entryNames(newSide), removed = entryNames(oldSide);
  return {
    namespace,
    added: added.filter(name => !removed.includes(name)),
    removed: removed.filter(name => !added.includes(name)),
  };
}

// "Interface/AddOns/Blizzard_ActionBar/x.lua" becomes "ActionBar/x.lua".
const shortPath = path => path.replace(/^Interface\/AddOns\//, '').replace(/^Blizzard_/, '');

export function summariseFiles(files) {
  const kept = files.filter(file => typeof file?.filename === 'string' && !IGNORED.has(file.filename));
  const addons = new Set(), api = [], changedFiles = [];
  let additions = 0, deletions = 0, quietDocs = 0;
  for (const file of kept) {
    additions += Number(file.additions) || 0;
    deletions += Number(file.deletions) || 0;
    const addon = file.filename.match(/^Interface\/AddOns\/([^/]+)\//)?.[1];
    if (addon) addons.add(addon);
    const doc = file.filename.match(DOC)?.[1];
    if (doc) {
      const changes = apiChanges(file.patch);
      if (file.status === 'added' || file.status === 'removed' || changes.added.length || changes.removed.length) {
        api.push({ name: doc, status: file.status, ...changes });
      } else {
        quietDocs++;
      }
    } else if (['added', 'removed', 'renamed'].includes(file.status)) {
      changedFiles.push({ status: file.status, path: shortPath(file.filename), from: file.previous_filename && shortPath(file.previous_filename) });
    }
  }
  const order = { added: 0, removed: 1 };
  api.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
  return {
    files: kept.length, capped: files.length >= FILE_CAP, additions, deletions,
    addons: [...addons].sort(), api, quietDocs, changedFiles,
  };
}

// The changes between the saved commit and the newest one: a comparison when
// the saved commit is still behind it, otherwise the newest commit alone.
async function findDiff(base, head, { token, fetcher, sleep }) {
  const options = { headers: githubHeaders(token), missing: [404], fetcher, sleep };
  const compare = await get(`${API}/compare/${base.sha}...${head.sha}`, 'GitHub', options);
  if (compare?.status === 'ahead' && Array.isArray(compare.files)) {
    return {
      builds: (compare.commits || []).map(commit => firstLine(commit?.commit?.message)).filter(Boolean),
      summary: summariseFiles(compare.files),
      url: `${WEB}/compare/${base.sha.slice(0, 12)}...${head.sha.slice(0, 12)}`,
      linkText: `Compare ${buildLabel(base)}...${buildLabel(head)}`,
    };
  }
  const commit = await get(`${API}/commits/${head.sha}`, 'GitHub', { ...options, missing: [] });
  if (!Array.isArray(commit?.files)) throw new Error('GitHub: unexpected commit');
  return {
    builds: [head.message],
    summary: summariseFiles(commit.files),
    url: `${WEB}/commit/${head.sha}`,
    linkText: `View commit ${head.sha.slice(0, 7)}`,
    note: 'The forever branch history changed, so this shows the newest commit only.',
  };
}

// The saved commit, commit message and ETag only move forward once the whole
// check has worked, so a failure is simply tried again next run.
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
  if (!known) return { entry, first: true };
  if (head.sha === known.sha) return { entry, kind: 'same' };
  return { entry, kind: 'new', event: { base: known, head: entry, ...(await findDiff(known, entry, { token, fetcher, sleep })) } };
}

function nameList(names, cap = 10) {
  const shown = names.slice(0, cap).join(', ');
  return names.length > cap ? `${shown}, +${names.length - cap} more` : shown;
}

function apiLines({ api, quietDocs }) {
  const lines = api.map(doc => {
    const label = escapeMarkdown(doc.namespace || doc.name);
    if (doc.status === 'added') return `• New ${label}${doc.added.length ? `: ${nameList(doc.added.map(escapeMarkdown))}` : ''}`;
    if (doc.status === 'removed') return `• Removed ${label}`;
    return `• ${label}: ${nameList([...doc.added.map(name => `+${escapeMarkdown(name)}`), ...doc.removed.map(name => `-${escapeMarkdown(name)}`)])}`;
  });
  if (quietDocs) lines.push(`• ${quietDocs} more ${quietDocs === 1 ? 'doc' : 'docs'} changed`);
  return lines;
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
  const count = summary.capped ? `${FILE_CAP}+ files (GitHub lists the first ${FILE_CAP})`
    : `${summary.files} ${summary.files === 1 ? 'file' : 'files'}`;
  const top = [`${count}, +${summary.additions} / -${summary.deletions} lines. [${escapeMarkdown(linkText)}](${url})`];
  if (builds.length > 1) top.push(`Covers ${builds.map(escapeMarkdown).join(', ')}.`);
  if (note) top.push(note);
  let description = top.join('\n');
  const api = apiLines(summary);
  if (api.length) description += `\n\n**API changes**\n${fitLines(api, 3200 - description.length)}`;
  const fields = [];
  if (summary.addons.length) {
    fields.push({ name: `Blizzard addons changed (${summary.addons.length})`, value: addonList(summary.addons, watch) });
  }
  if (summary.changedFiles.length) {
    fields.push({ name: 'Files added or removed', value: fitLines(summary.changedFiles.map(fileLine), 1024) });
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
