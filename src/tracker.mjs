// Forever tracker, by Squirt. All rights reserved. No third-party runtime
// dependencies.
// Tells a staff Discord channel when WoW Forever changes: a new build on
// Blizzard's patch server, the Blizzard UI source that came with it, and
// Forever patch notes or hotfixes posted by Blizzard staff on the forums.
// Blizzard and GitHub are only read; the one thing it sends is the Discord
// message.
//
//   node src/tracker.mjs              check and post (needs FOREVER_TRACKER_WEBHOOK)
//   node src/tracker.mjs --dry-run    check and print the messages instead
//   node src/tracker.mjs --seed-old   dry run from an older build, to preview real messages
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { get, pause } from './http.mjs';
import { emptyState, loadState, saveState } from './state.mjs';
import { COLOURS, escapeMarkdown, message, sendDiscord, sendOutbox, validateWebhook } from './discord.mjs';
import { DEFAULT_PRODUCTS, buildEmbed, checkPatch, regionText } from './patch.mjs';
import { API, BRANCH, checkUiSource, githubHeaders, uiEmbed } from './uisource.mjs';
import { checkForum, forumMessages, trackerUrl } from './forum.mjs';

const FAIL_ALERT = 8; // eight runs in a row, about two hours
const yes = value => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
const list = value => String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);

export function readOptions(env = {}, argv = []) {
  const seedOld = argv.includes('--seed-old');
  const products = list(env.FOREVER_PRODUCTS).filter(product => /^[a-z0-9_]+$/.test(product));
  const repository = /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '') ? env.GITHUB_REPOSITORY : null;
  return {
    seedOld,
    dryRun: seedOld || argv.includes('--dry-run') || yes(env.DRY_RUN),
    stateFile: env.STATE_FILE || '.state/state.json',
    stateKey: /^[\w.-]+$/.test(env.STATE_KEY || '') ? env.STATE_KEY : 'forever-tracker-state-',
    products: products.length ? products : DEFAULT_PRODUCTS,
    knownIssues: yes(env.INCLUDE_KNOWN_ISSUES),
    watch: list(env.WATCH_ADDONS),
    ping: /^\d{5,25}$/.test(env.PING_ROLE_ID || '') ? env.PING_ROLE_ID : null,
    token: env.GITHUB_TOKEN || null,
    repository,
    workflow: env.GITHUB_WORKFLOW_REF?.match(/\.github\/workflows\/([\w.-]+)@/)?.[1] || 'tracker.yml',
    actions: env.GITHUB_ACTIONS === 'true',
  };
}

// On GitHub, with no state file: whether a saved state is in the Actions cache
// (true), none is (false), or GitHub couldn't say (null). One that is there
// but wasn't restored means the cache had an error.
async function stateInCache(options, web) {
  try {
    const caches = await get(`https://api.github.com/repos/${options.repository}/actions/caches?key=${encodeURIComponent(options.stateKey)}&per_page=1`,
      'GitHub', { headers: githubHeaders(options.token), ...web });
    return Array.isArray(caches?.actions_caches) ? caches.actions_caches.length > 0 : null;
  } catch {
    return null;
  }
}

// With no saved state anywhere, a successful scheduled run before this one
// means the state was lost, not that this is the start. Scheduled runs are
// never dry runs, and one that records nothing on a fresh start fails.
async function stateWasLost(options, web) {
  try {
    const runs = await get(`https://api.github.com/repos/${options.repository}/actions/workflows/${options.workflow}/runs?event=schedule&status=success&per_page=1`,
      'GitHub', { headers: githubHeaders(options.token), ...web });
    return Number(runs?.total_count) > 0;
  } catch {
    return false;
  }
}

export function liveEmbed(state, { products, latest, lost, now }) {
  const lines = [];
  for (const product of products) {
    const build = state.builds[product];
    const name = products.length > 1 ? ` (${product})` : '';
    lines.push(build ? `Build ${build.version}${name}. ${regionText(build)}`.trim()
      : `Build${name}: the patch server didn't answer, so it will be recorded on a later run.`);
  }
  lines.push(state.ui ? `UI source at ${escapeMarkdown(state.ui.message || state.ui.sha.slice(0, 7))}.`
    : "UI source: GitHub didn't answer, so it will be recorded on a later run.");
  if (latest) lines.push(`Latest notes: [${escapeMarkdown(latest.title)}](${latest.url})`);
  lines.push('', 'New Forever builds, their UI source changes and Forever patch notes will be posted here.');
  if (lost) lines.push('The saved state was lost, so anything that changed while it was missing was not posted.');
  return { title: 'Forever tracker is live', description: lines.join('\n'), color: COLOURS.live, timestamp: now.toISOString() };
}

// For --seed-old: saved state from one build back, built from live data, so a
// dry run formats real messages from start to finish. Never saved.
async function seedOldState(options, web, now) {
  const commits = await get(`${API}/commits?sha=${BRANCH}&per_page=2`, 'GitHub', { headers: githubHeaders(options.token), ...web });
  const older = Array.isArray(commits) ? commits[1] : null;
  const build = older?.commit?.message?.match(/^(\d+\.\d+\.\d+) \((\d+)\)/);
  if (!build) throw new Error('--seed-old: unexpected commit list');
  const newest = await get(trackerUrl(), 'Forum', web);
  const before = Math.min(...newest.posts.map(post => post.id));
  const page2 = await get(trackerUrl(before), 'Forum', web);
  const state = emptyState();
  state.startedAt = now.toISOString();
  for (const product of options.products) {
    state.builds[product] = { version: `${build[1]}.${build[2]}`, buildId: Number(build[2]), buildConfig: '', seqn: 0, regions: {} };
  }
  state.ui = { sha: older.sha, message: older.commit.message.split('\n')[0], etag: null };
  state.forum = { highWater: Math.min(...page2.posts.map(post => post.id)), seen: [], notesTopics: {}, otherTopics: [], categories: {} };
  return state;
}

export async function run({
  env = process.env, argv = process.argv.slice(2), fetcher = fetch, sleep = pause,
  log = console.log, print = console.log, now = () => new Date(),
} = {}) {
  const options = readOptions(env, argv);
  const webhook = options.dryRun ? null : validateWebhook(env.FOREVER_TRACKER_WEBHOOK);
  const web = { fetcher, sleep };
  const warn = text => log(options.actions ? `::warning::${text}` : text);
  const onGitHub = Boolean(options.repository && options.token);
  let state = options.seedOld ? await seedOldState(options, web, now()) : await loadState(options.stateFile, log);
  const missing = !state;
  // No state file on GitHub: if a saved state is in the cache, restoring it
  // failed. Starting again would skip anything new since the last run, so
  // this run stops without checking or saving, and the next one tries again.
  if (missing && onGitHub) {
    const cached = await stateInCache(options, web);
    if (cached !== false) {
      warn(cached ? 'The saved state is in the cache but was not restored. Nothing was checked or saved; the next run tries again.'
        : "Couldn't ask GitHub whether a saved state exists. Nothing was checked or saved; the next run tries again.");
      return { exitCode: 1, state: null };
    }
  }
  state ||= emptyState();
  const save = () => (options.dryRun ? Promise.resolve() : saveState(options.stateFile, state));
  const fresh = !state.startedAt;
  const found = [];
  let worked = 0, failures = 0, alert = false, latest = null;

  // Each source is checked on its own, and its saved state only moves once its
  // messages are ready. One that fails keeps its saved state, posts nothing, and
  // marks the run failed once after eight failures in a row.
  async function source(name, key, check) {
    try {
      await check();
      worked++;
      if ((state.health[key]?.fails || 0) >= FAIL_ALERT) log(`${name} is working again.`);
      delete state.health[key];
    } catch (error) {
      failures++;
      const health = state.health[key] ||= { fails: 0, since: now().toISOString() };
      health.fails++;
      warn(`${error.message}${health.fails > 1 ? ` (${health.fails} runs in a row)` : ''}`);
      if (health.fails === FAIL_ALERT) {
        alert = true;
        warn(`${name} has failed ${FAIL_ALERT} runs in a row, since ${health.since}.`);
      }
    }
  }

  for (const product of options.products) {
    await source(`Patch server (${product})`, `patch:${product}`, async () => {
      const result = await checkPatch(state.builds[product], product, {
        fetchText: url => get(url, 'Patch server', { json: false, ...web }),
      });
      if (result.event) {
        found.push({ key: `build:${product}:${result.entry.buildId}`, payload: message(buildEmbed(result.event, now()), { ping: options.ping }) });
      }
      state.builds[product] = result.entry;
      log(`Patch server (${product}): ${result.entry.version}${result.first ? ', recorded' : `, ${result.kind}`}.`);
    });
  }

  await source('GitHub', 'github', async () => {
    const result = await checkUiSource(state.ui, { token: options.token, ...web });
    if (result.event) found.push({ key: `ui:${result.entry.sha}`, payload: message(uiEmbed(result.event, { watch: options.watch })) });
    state.ui = result.entry;
    log(result.kind === 'older' ? `UI source: ${result.head.message} is not newer than ${result.entry.message}, so not posted.`
      : `UI source: ${result.entry.message}${result.first ? ', recorded' : `, ${result.kind}`}.`);
  });

  await source('Forum', 'forum', async () => {
    const result = await checkForum(state.forum, {
      get: (url, extra = {}) => get(url, 'Forum', { ...extra, ...web }), knownIssues: options.knownIssues, now: now().getTime(),
    });
    const messages = forumMessages(result.events).map(item => ({ key: item.key, payload: message(item.embed) }));
    found.push(...messages);
    state.forum = result.entry;
    latest = result.latest;
    log(result.first ? `Forum: ${result.checked} staff posts recorded.` : `Forum: ${result.checked} new staff posts, ${result.events.length} Forever notes.`);
  });

  // The first run only records where everything is, then says it's live. A
  // first run where nothing worked records nothing, and fails.
  const queued = now().toISOString();
  if (fresh) {
    if (worked) {
      state.startedAt = queued;
      const lost = missing && onGitHub && await stateWasLost(options, web);
      state.outbox = [{ key: 'live', attempts: 0, queued, payload: message(liveEmbed(state, { products: options.products, latest, lost, now: now() })) }];
    }
  } else {
    for (const item of found) {
      if (!state.outbox.some(waiting => waiting.key === item.key)) state.outbox.push({ ...item, attempts: 0, queued });
    }
  }
  await save();

  const result = await sendOutbox(state, {
    dryRun: options.dryRun, print, sleep, log, save, now: now(),
    send: payload => sendDiscord(webhook, payload, web),
  });
  const count = `${result.sent} ${result.sent === 1 ? 'message' : 'messages'}`;
  log(options.dryRun ? `Dry run: ${count} printed, nothing sent.` : `Sent ${count}.`);
  const failed = result.failed || alert || (options.dryRun && failures > 0) || (fresh && !worked);
  return { exitCode: failed ? 1 : 0, state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then(({ exitCode }) => { process.exitCode = exitCode; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
