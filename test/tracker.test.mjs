// Run with: node --test
// The whole tracker against a fake web: patch server, GitHub, forums and Discord.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOptions, run } from '../src/tracker.mjs';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const table = await fixture('versions.txt');
const page = JSON.parse(await fixture('tracker-page.json')).posts;
const categories = JSON.parse(await fixture('categories.json'));
const HOOK = 'https://discord.com/api/webhooks/123456/secret_TOKEN-abc';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const commit = (sha, message) => ({ sha, commit: { message, committer: { date: '2026-09-30T01:00:00Z' } } });
const notesPost = {
  id: 30300001, created_at: '2026-09-30T01:20:00.000Z', topic_id: 2370001, post_number: 1, post_type: 1, category_id: 349,
  topic_title: 'Beta Client Update - September 30', url: '/t/beta-client-update-september-30/2370001/1',
  username: 'Kaivax', user_title: 'Community Manager', excerpt: 'Sample update text.', truncated: false,
};

function world() {
  const web = {
    versions: table, patchStatus: 200, commits: [commit(A, '1.60.1 (70009)')], compare: null, githubStatus: 200,
    posts: [...page], forumStatus: 200, discordStatus: 200, earlierRuns: 0, caches: 0, cacheStatus: 200, posted: [], asked: [],
  };
  web.fetcher = async (url, init) => {
    const href = String(url);
    web.asked.push({ url: href, method: init.method, headers: init.headers });
    if (href.startsWith('https://discord.com/')) {
      if (web.discordStatus !== 200) return new Response('{}', { status: web.discordStatus });
      web.posted.push(JSON.parse(init.body));
      return Response.json({ id: String(web.posted.length) });
    }
    if (href.includes('battle.net')) return new Response(web.versions, { status: web.patchStatus });
    if (href.startsWith('https://api.github.com/')) {
      if (href.includes('/actions/caches?key=forever-tracker-state-&')) {
        if (web.cacheStatus !== 200) return new Response('{}', { status: web.cacheStatus });
        return Response.json({ total_count: web.caches, actions_caches: Array.from({ length: Math.min(web.caches, 1) }, () => ({ key: 'forever-tracker-state-1-1' })) });
      }
      if (web.githubStatus !== 200) return new Response('{}', { status: web.githubStatus });
      if (href.includes('/actions/workflows/tracker.yml/runs?event=schedule&status=success')) return Response.json({ total_count: web.earlierRuns });
      if (href.includes('/commits?sha=forever')) {
        const etag = `"${web.commits[0].sha}"`;
        if (init.headers['If-None-Match'] === etag) return new Response(null, { status: 304 });
        return Response.json(web.commits, { headers: { ETag: etag } });
      }
      if (href.includes('/compare/')) return Response.json(web.compare);
    }
    if (href.startsWith('https://us.forums.blizzard.com/en/wow/')) {
      if (web.forumStatus !== 200) return new Response('{}', { status: web.forumStatus });
      let match;
      if ((match = href.match(/blizzard-tracker\/posts\.json(?:\?before_post_id=(\d+))?$/))) {
        const before = match[1] ? Number(match[1]) : Infinity;
        return Response.json({ posts: web.posts.filter(post => post.id < before).sort((a, b) => b.id - a.id).slice(0, 20) });
      }
      if ((match = href.match(/\/c\/(\d+)\/show\.json$/)) && categories[match[1]]) {
        const found = categories[match[1]];
        return Response.json({ category: { id: Number(match[1]), name: found.name, parent_category_id: found.parent } });
      }
    }
    return new Response('{}', { status: 404 });
  };
  return web;
}

async function tracker(web, { env = {}, argv = [] } = {}) {
  const logs = [], printed = [];
  const result = await run({
    env: { FOREVER_TRACKER_WEBHOOK: HOOK, GITHUB_TOKEN: 'test-token', ...env }, argv, fetcher: web.fetcher,
    sleep: async () => {}, log: line => logs.push(line), print: text => printed.push(text), now: () => new Date('2026-09-30T02:00:00Z'),
  });
  assert.ok(![...logs, ...printed].some(line => line.includes('secret_TOKEN')), 'the webhook never shows in the output');
  return { ...result, logs, printed };
}
const stateFile = async () => join(await mkdtemp(join(tmpdir(), 'forever-tracker-')), '.state', 'state.json');
const readState = async file => JSON.parse(await readFile(file, 'utf8'));
const titles = web => web.posted.map(payload => payload.embeds[0].title);

test('the first run records everything and posts one "live" message', async () => {
  const web = world(), file = await stateFile();
  const first = await tracker(web, { env: { STATE_FILE: file } });
  assert.equal(first.exitCode, 0);
  assert.deepEqual(titles(web), ['Forever tracker is live']);
  const [live] = web.posted;
  assert.deepEqual(live.allowed_mentions, { parse: [] });
  assert.equal(live.content, undefined);
  assert.equal(live.embeds[0].description, [
    'Build 1.60.1.70009. On US, EU, KR, TW.',
    'UI source at 1.60.1 (70009).',
    'Latest notes: [WoW Forever Beta Development Notes – Updated September 24](https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-updated-september-24/2360696/1)',
    '',
    'New Forever builds, their UI source changes and Forever patch notes will be posted here.',
  ].join('\n'));
  const saved = await readState(file);
  assert.equal(saved.startedAt, '2026-09-30T02:00:00.000Z');
  assert.equal(saved.builds.wow_classic_beta.version, '1.60.1.70009');
  assert.equal(saved.ui.sha, A);
  assert.equal(saved.forum.highWater, 30245030);
  assert.deepEqual(saved.outbox, []);

  const second = await tracker(web, { env: { STATE_FILE: file } });
  assert.equal(second.exitCode, 0);
  assert.equal(web.posted.length, 1, 'nothing new, nothing posted');
  const githubAsks = web.asked.filter(ask => ask.url.includes('/commits?sha=forever'));
  assert.equal(githubAsks.at(-1).headers['If-None-Match'], `"${A}"`);
  assert.equal(githubAsks.at(-1).headers.Authorization, 'Bearer test-token');
  assert.ok(web.asked.every(ask => ask.method === 'GET' || ask.url.startsWith('https://discord.com/')), 'only Discord is ever sent anything');
});

test('a new build, its UI source and its notes are posted once, in that order', async () => {
  const web = world(), file = await stateFile();
  await tracker(web, { env: { STATE_FILE: file } });
  web.versions = table.replaceAll('70009', '70010');
  web.commits = [commit(B, '1.60.1 (70010)'), commit(A, '1.60.1 (70009)')];
  web.compare = { status: 'ahead', commits: [commit(B, '1.60.1 (70010)')], files: [
    { filename: 'Interface/AddOns/Blizzard_CooldownViewer/CooldownViewer.lua', status: 'modified', additions: 3, deletions: 1 },
  ] };
  web.posts.push(notesPost);
  const result = await tracker(web, { env: { STATE_FILE: file, PING_ROLE_ID: '112233445566' } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(titles(web).slice(1), ['New Forever build: 1.60.1.70010', 'UI source for 1.60.1 (70010)', 'Beta Client Update - September 30']);
  const [build, ui, notes] = web.posted.slice(1);
  assert.equal(build.embeds[0].description, 'Was 1.60.1.70009. On US, EU, KR, TW.');
  assert.equal(build.content, '<@&112233445566>', 'a role is pinged for new builds only when one is set up');
  assert.equal(ui.content, undefined);
  assert.match(ui.embeds[0].description, /^1 file, \+3 \/ -1 lines\. \[Compare 70009\.\.\.70010\]/);
  assert.equal(notes.embeds[0].url, 'https://us.forums.blizzard.com/en/wow/t/beta-client-update-september-30/2370001/1');
  assert.equal(notes.embeds[0].footer.text, 'WoW: Forever Beta Discussion');
  await tracker(web, { env: { STATE_FILE: file } });
  assert.equal(web.posted.length, 4, 'nothing is posted twice');
});

test('a failing source keeps its state, and catches up later without repeats', async () => {
  const web = world(), file = await stateFile();
  await tracker(web, { env: { STATE_FILE: file } });
  const before = await readState(file);
  web.forumStatus = 503;
  web.patchStatus = 500;
  web.posts.push(notesPost);
  const down = await tracker(web, { env: { STATE_FILE: file, GITHUB_ACTIONS: 'true' } });
  assert.equal(down.exitCode, 0, 'one bad run is only a warning');
  assert.ok(down.logs.includes('::warning::Forum: HTTP 503'));
  assert.ok(down.logs.includes('::warning::Patch server: HTTP 500'));
  const during = await readState(file);
  assert.deepEqual(during.forum, before.forum);
  assert.deepEqual(during.builds, before.builds);
  assert.equal(during.health.forum.fails, 1);
  assert.equal(web.posted.length, 1);
  web.forumStatus = 200;
  web.patchStatus = 200;
  await tracker(web, { env: { STATE_FILE: file } });
  await tracker(web, { env: { STATE_FILE: file } });
  assert.deepEqual(titles(web).slice(1), ['Beta Client Update - September 30']);
  assert.equal((await readState(file)).health.forum, undefined);
});

test('eight failed runs in a row mark the run failed, once', async () => {
  const web = world(), file = await stateFile();
  await tracker(web, { env: { STATE_FILE: file } });
  web.forumStatus = 503;
  const codes = [];
  for (let runs = 1; runs <= 9; runs++) codes.push((await tracker(web, { env: { STATE_FILE: file } })).exitCode);
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.equal(web.posted.length, 1, 'health is not posted to Discord');
});

test('when Discord is down, messages wait in the outbox for the next run', async () => {
  const web = world(), file = await stateFile();
  await tracker(web, { env: { STATE_FILE: file } });
  web.posts.push(notesPost);
  web.discordStatus = 503;
  const down = await tracker(web, { env: { STATE_FILE: file } });
  assert.equal(down.exitCode, 1);
  assert.ok(down.logs.includes('Discord: HTTP 503 (forum:30300001, try 1)'));
  const queued = await readState(file);
  assert.deepEqual(queued.outbox.map(item => [item.key, item.attempts, item.queued]), [['forum:30300001', 1, '2026-09-30T02:00:00.000Z']]);
  web.discordStatus = 200;
  const back = await tracker(web, { env: { STATE_FILE: file } });
  assert.equal(back.exitCode, 0);
  assert.deepEqual(titles(web).slice(1), ['Beta Client Update - September 30']);
  assert.deepEqual((await readState(file)).outbox, []);
});

test('a deleted webhook loses nothing: messages wait until the secret is fixed', async () => {
  const web = world(), file = await stateFile();
  await tracker(web, { env: { STATE_FILE: file } });
  web.posts.push(notesPost);
  web.discordStatus = 404;
  for (let runs = 1; runs <= 10; runs++) assert.equal((await tracker(web, { env: { STATE_FILE: file } })).exitCode, 1);
  assert.deepEqual((await readState(file)).outbox.map(item => [item.key, item.attempts]), [['forum:30300001', 10]]);
  web.discordStatus = 200;
  await tracker(web, { env: { STATE_FILE: file } });
  assert.deepEqual(titles(web).slice(1), ['Beta Client Update - September 30']);
});

test('the first run with every source down posts nothing, fails, and stays a first run', async () => {
  const web = world(), file = await stateFile();
  const env = { STATE_FILE: file, GITHUB_REPOSITORY: 'squirtwow/forever-tracker' };
  web.patchStatus = web.githubStatus = web.forumStatus = 503;
  const down = await tracker(web, { env });
  assert.equal(down.exitCode, 1, 'so GitHub never counts it as a working run');
  assert.equal(web.posted.length, 0);
  assert.equal((await readState(file)).startedAt, null);
  web.patchStatus = web.githubStatus = web.forumStatus = 200;
  web.earlierRuns = 1;
  const up = await tracker(web, { env });
  assert.equal(up.exitCode, 0);
  assert.deepEqual(titles(web), ['Forever tracker is live']);
  assert.doesNotMatch(web.posted[0].embeds[0].description, /lost/, 'its saved state was restored, so nothing was lost');
});

test('a source that was down on the first run is recorded quietly later', async () => {
  const web = world(), file = await stateFile();
  web.githubStatus = 503;
  await tracker(web, { env: { STATE_FILE: file } });
  assert.match(web.posted[0].embeds[0].description, /UI source: GitHub didn't answer, so it will be recorded on a later run\./);
  web.githubStatus = 200;
  web.commits = [commit(B, '1.60.1 (70010)'), commit(A, '1.60.1 (70009)')];
  await tracker(web, { env: { STATE_FILE: file } });
  assert.equal(web.posted.length, 1);
  assert.equal((await readState(file)).ui.sha, B);
});

const onGitHub = { GITHUB_REPOSITORY: 'squirtwow/forever-tracker', GITHUB_WORKFLOW_REF: 'squirtwow/forever-tracker/.github/workflows/tracker.yml@refs/heads/main', GITHUB_ACTIONS: 'true' };

test('lost state says so, when no saved state is left and an earlier scheduled run had worked', async () => {
  const web = world();
  web.earlierRuns = 3;
  await tracker(web, { env: { ...onGitHub, STATE_FILE: await stateFile() } });
  assert.match(web.posted[0].embeds[0].description, /The saved state was lost, so anything that changed while it was missing was not posted\.$/);
  web.earlierRuns = 0;
  await tracker(web, { env: { ...onGitHub, STATE_FILE: await stateFile() } });
  assert.doesNotMatch(web.posted[1].embeds[0].description, /lost/);
});

test('a saved state the cache failed to restore stops the run without checking or saving anything', async () => {
  const web = world(), file = await stateFile();
  web.caches = 3;
  web.earlierRuns = 3;
  const result = await tracker(web, { env: { ...onGitHub, STATE_FILE: file } });
  assert.equal(result.exitCode, 1);
  assert.ok(result.logs.includes('::warning::The saved state is in the cache but was not restored. Nothing was checked or saved; the next run tries again.'));
  assert.ok(!web.asked.some(ask => /battle\.net|forums\.blizzard|commits\?sha|discord\.com/.test(ask.url)), 'nothing checked or posted');
  await assert.rejects(readFile(file), { code: 'ENOENT' }, 'nothing saved, so the next run restores the real state');
  web.cacheStatus = 500;
  const unknown = await tracker(web, { env: { ...onGitHub, STATE_FILE: file } });
  assert.equal(unknown.exitCode, 1, 'when GitHub cannot say, it is safer to wait');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('a dry run prints the messages, sends nothing and saves nothing', async () => {
  const web = world(), file = await stateFile();
  const result = await tracker(web, { env: { STATE_FILE: file, FOREVER_TRACKER_WEBHOOK: '' }, argv: ['--dry-run'] });
  assert.equal(result.exitCode, 0);
  assert.equal(web.posted.length, 0);
  assert.ok(!web.asked.some(ask => ask.url.startsWith('https://discord.com/')));
  assert.match(result.printed[0], /^--- Would post \(live\) ---\n/);
  assert.equal(JSON.parse(result.printed[0].split('\n').slice(1).join('\n')).embeds[0].title, 'Forever tracker is live');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  web.forumStatus = 503;
  assert.equal((await tracker(web, { env: { STATE_FILE: file, DRY_RUN: '1' } })).exitCode, 1, 'a dry run shows any failing source');
});

test('without the webhook secret nothing is checked', async () => {
  const web = world();
  await assert.rejects(tracker(web, { env: { FOREVER_TRACKER_WEBHOOK: '', STATE_FILE: await stateFile() } }), /^Error: FOREVER_TRACKER_WEBHOOK is not set$/);
  await assert.rejects(tracker(web, { env: { FOREVER_TRACKER_WEBHOOK: 'https://example.com/hook', STATE_FILE: await stateFile() } }),
    /^Error: FOREVER_TRACKER_WEBHOOK is not a Discord webhook URL$/);
  assert.equal(web.asked.length, 0);
});

test('options from the environment', () => {
  const options = readOptions({
    FOREVER_PRODUCTS: 'wow_classic_beta, wow_forever ,bad-name', PING_ROLE_ID: 'everyone', INCLUDE_KNOWN_ISSUES: 'true',
    WATCH_ADDONS: 'CooldownViewer, TrainerUI', GITHUB_REPOSITORY: 'a/b; rm', DRY_RUN: '',
  }, []);
  assert.deepEqual(options.products, ['wow_classic_beta', 'wow_forever']);
  assert.equal(options.ping, null);
  assert.equal(options.knownIssues, true);
  assert.deepEqual(options.watch, ['CooldownViewer', 'TrainerUI']);
  assert.equal(options.repository, null);
  assert.equal(options.dryRun, false);
  assert.equal(options.stateFile, '.state/state.json');
  assert.deepEqual(readOptions({}, []).products, ['wow_classic_beta']);
  assert.equal(readOptions({}, ['--seed-old']).dryRun, true);
});
