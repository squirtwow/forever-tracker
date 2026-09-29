// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkForum, cleanExcerpt, forumEmbed, forumMessages, isNotesTitle, postUrl } from '../src/forum.mjs';

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const page = (await fixture('tracker-page.json')).posts;
const categories = await fixture('categories.json');
const NOW = Date.parse('2026-09-29T10:00:00Z');

// A fake forum: the Blue Tracker feed (newest first, `size` per page),
// categories, first posts of topics and single posts.
function forum({ posts = page, size = 20, firsts = {}, singles = {}, fail = null } = {}) {
  const asked = [];
  const get = async (url, { missing = [] } = {}) => {
    asked.push(url);
    if (fail?.test(url)) throw new Error('Forum: HTTP 503');
    let match;
    if ((match = url.match(/\/groups\/blizzard-tracker\/posts\.json(?:\?before_post_id=(\d+))?$/))) {
      const before = match[1] ? Number(match[1]) : Infinity;
      return { posts: posts.filter(post => post.id < before).sort((a, b) => b.id - a.id).slice(0, size) };
    }
    const answer = value => {
      if (value !== undefined) return value;
      if (missing.includes(404)) return null;
      throw new Error('Forum: HTTP 404');
    };
    if ((match = url.match(/\/c\/(\d+)\/show\.json$/))) {
      const found = categories[match[1]];
      return answer(found && { category: { id: Number(match[1]), name: found.name, parent_category_id: found.parent } });
    }
    if ((match = url.match(/\/posts\/by_number\/(\d+)\/1\.json$/))) return answer(firsts[match[1]]);
    if ((match = url.match(/\/posts\/(\d+)\.json$/))) return answer(singles[match[1]]);
    throw new Error(`unexpected ${url}`);
  };
  return { get, asked };
}
const post = (id, extra = {}) => ({
  id, created_at: '2026-09-30T02:00:00.000Z', topic_id: 2370000 + id % 1000, post_number: 1, post_type: 1, category_id: 349,
  topic_title: `WoW Forever Beta Development Notes ${id}`, url: `/t/notes/${2370000 + id % 1000}/1`,
  username: 'Kaivax', user_title: 'Community Manager', excerpt: 'Sample notes.', truncated: false, ...extra,
});
const firstRun = async (options = {}) => (await checkForum(null, { now: NOW, ...forum(options), ...options })).entry;

test('which titles are patch notes', () => {
  for (const title of ['WoW Forever Beta Development Notes – Updated September 24', 'Beta Client Update - September 22',
    'WoW Forever Hotfixes - October 3', 'Patch 1.61 Notes', 'Forever Patch Notes', 'Changelog', 'Update Notes: Launch']) {
    assert.equal(isNotesTitle(title), true, title);
  }
  for (const title of ['Beta is Up - Development Notes Posted', 'Auto-shoot Bug and Fix Incoming', 'Beta Realm Restarts Incoming',
    'WoW Forever Beta Known Issues - September 24', 'Hotfixing things', undefined]) {
    assert.equal(isNotesTitle(title), false, title);
  }
  assert.equal(isNotesTitle('WoW Forever Beta Known Issues - September 24', true), true, 'only with the option on');
});

test('the first time, everything is recorded and nothing is posted', async () => {
  const web = forum();
  const result = await checkForum(null, { now: NOW, ...web });
  assert.equal(result.first, true);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.latest, {
    title: 'WoW Forever Beta Development Notes – Updated September 24',
    url: 'https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-updated-september-24/2360696/1',
  });
  assert.equal(result.entry.highWater, 30245030);
  assert.equal(result.entry.seen.length, 8);
  assert.deepEqual(Object.keys(result.entry.notesTopics).sort(), ['2358655', '2360696']);
  assert.ok(!web.asked.some(url => /\/posts\//.test(url.replace(/blizzard-tracker\/posts\.json.*/, ''))), 'no reply lookups');
  assert.equal(result.entry.categories[349].forever, true);
  assert.equal(result.entry.categories[345].forever, false);
});

test('a new Forever notes topic is posted; retail, PTR, announcements and chat are not', async () => {
  const saved = await firstRun();
  const news = [
    post(30300001, { category_id: 171, topic_title: 'World of Warcraft: Midnight Hotfixes - October 1' }),
    post(30300002, { category_id: 345, topic_title: 'Midnight: 12.1.7 PTR Development Notes' }),
    post(30300003, { topic_title: 'Beta is Up - Development Notes Posted' }),
    post(30300004, { topic_title: 'Realm maintenance' }),
    post(30300005, { post_type: 4, topic_title: 'WoW Forever Hotfixes' }),
    post(30300006, { category_id: 171, topic_title: 'WoW Forever Patch Notes' }),
    post(30300007, { category_id: 360, topic_title: 'Hotfixes - November 5' }),
    post(30300008),
  ];
  const result = await checkForum(saved, { now: NOW, ...forum({ posts: [...page, ...news] }) });
  assert.deepEqual(result.events.map(item => [item.kind, item.post.id]), [['notes', 30300006], ['notes', 30300007], ['notes', 30300008]]);
  assert.equal(result.events[0].category, 'General Discussion', 'Forever in the title is enough');
  assert.equal(result.events[1].category, 'Launch Discussion', 'a new subforum under WoW: Forever counts');
  assert.equal(result.entry.categories[360].forever, true);
});

test('Known Issues posts only with the option on', async () => {
  const saved = await firstRun();
  const issues = post(30300010, { topic_title: 'WoW Forever Beta Known Issues - October 1' });
  assert.deepEqual((await checkForum(saved, { now: NOW, ...forum({ posts: [...page, issues] }) })).events, []);
  const on = await checkForum(saved, { now: NOW, knownIssues: true, ...forum({ posts: [...page, issues] }) });
  assert.deepEqual(on.events.map(item => item.post.id), [30300010]);
});

test('a staff update inside a notes topic counts; a chat reply does not', async () => {
  const saved = await firstRun();
  const reply = (id, topic, title) => post(id, { topic_id: topic, post_number: 7, topic_title: title, url: `/t/x/${topic}/7` });
  const news = [
    reply(30300020, 2360696, 'WoW Forever Beta Development Notes – Updated September 30'), // known notes topic, standalone
    reply(30300021, 2360696, 'WoW Forever Beta Development Notes – Updated September 30'), // quotes a player
    reply(30300022, 2360696, 'WoW Forever Beta Development Notes – Updated September 30'), // answers a player
    reply(30300023, 2380001, 'WoW Forever Hotfixes - October 1'), // staff topic seen for the first time
    reply(30300024, 2360635, 'Patch Notes?'), // a player's topic
    reply(30300025, 2360635, 'Patch Notes?'),
  ];
  const web = forum({
    posts: [...page, ...news],
    firsts: { 2380001: { staff: true }, 2360635: { staff: false } },
    singles: {
      30300020: { reply_to_post_number: null, raw: 'Hotfix: fixed an error in the trainer.' },
      30300021: { reply_to_post_number: null, raw: '[quote="Player, post:3"]\nWhen?\n[/quote]\nSoon.' },
      30300022: { reply_to_post_number: 4, raw: 'Thanks!' },
      30300023: { reply_to_post_number: null, raw: 'Hotfixes for October 1.' },
    },
  });
  const result = await checkForum(saved, { now: NOW, ...web });
  assert.deepEqual(result.events.map(item => [item.kind, item.post.id]), [['update', 30300020], ['update', 30300023]]);
  assert.deepEqual(result.entry.otherTopics, [2360635]);
  assert.equal(web.asked.filter(url => url.endsWith('/posts/by_number/2360635/1.json')).length, 1, 'the player topic is looked up once');
  assert.equal(web.asked.filter(url => url.endsWith('/posts/30300025.json')).length, 0);
  assert.equal(result.entry.notesTopics[2380001], 'WoW Forever Hotfixes - October 1');
  assert.equal(result.entry.notesTopics[2360696], 'WoW Forever Beta Development Notes – Updated September 30');
});

test('a deleted post is skipped rather than stopping the forum', async () => {
  const saved = await firstRun();
  const gone = post(30300030, { topic_id: 2360696, post_number: 9 });
  const result = await checkForum(saved, { now: NOW, ...forum({ posts: [...page, gone] }) });
  assert.deepEqual(result.events, []);
  assert.ok(result.entry.seen.includes(30300030));
});

test('nothing is posted twice', async () => {
  const saved = await firstRun();
  const posts = [...page, post(30300040)];
  const once = await checkForum(saved, { now: NOW, ...forum({ posts }) });
  assert.equal(once.events.length, 1);
  const twice = await checkForum(once.entry, { now: NOW, ...forum({ posts }) });
  assert.deepEqual(twice.events, []);
  // A post that shows up late, with an older id than the newest seen, still counts once.
  const late = post(30300035);
  const third = await checkForum(twice.entry, { now: NOW, ...forum({ posts: [...posts, late] }) });
  assert.deepEqual(third.events.map(item => item.post.id), [30300035]);
});

test('older pages are read back to the last post seen, at most three pages', async () => {
  const saved = await firstRun();
  const news = Array.from({ length: 7 }, (_, i) => post(30300100 + i, { topic_title: `Realm news ${i}` }));
  news.push(post(30300050));
  const web = forum({ posts: [...page, ...news], size: 3 });
  const result = await checkForum(saved, { now: NOW, ...web });
  assert.equal(web.asked.filter(url => url.includes('blizzard-tracker')).length, 3);
  assert.equal(result.checked, 8, 'three pages of three, less the one already seen');
  assert.deepEqual(result.events.map(item => item.post.id), [30300050]);
});

test('a failing forum changes nothing', async () => {
  const saved = await firstRun();
  const before = structuredClone(saved);
  const news = [post(30300060, { category_id: 347 })];
  await assert.rejects(checkForum(saved, { now: NOW, ...forum({ posts: [...page, ...news], fail: /\/c\/347\// }) }), /Forum: HTTP 503/);
  await assert.rejects(checkForum(saved, { now: NOW, ...forum({ posts: [] }) }), /Forum: no staff posts listed/);
  await assert.rejects(checkForum(saved, { now: NOW, get: async () => ({ error: 'nope' }) }), /Forum: unexpected response/);
  assert.deepEqual(saved, before);
});

test('category names are checked again after a week', async () => {
  const saved = await firstRun();
  saved.categories[349] = { name: 'Old name', forever: false, checked: NOW - 8 * 86400000 };
  const result = await checkForum(saved, { now: NOW, ...forum({ posts: [...page, post(30300070)] }) });
  assert.equal(result.events.length, 1);
  assert.equal(result.entry.categories[349].name, 'WoW: Forever Beta Discussion');
});

test('the notes message', () => {
  const item = { kind: 'notes', category: 'WoW: Forever Beta Discussion', post: page[5] };
  const embed = forumEmbed(item);
  assert.equal(embed.title, 'WoW Forever Beta Development Notes – Updated September 24');
  assert.equal(embed.url, 'https://us.forums.blizzard.com/en/wow/t/wow-forever-beta-development-notes-updated-september-24/2360696/1');
  assert.deepEqual(embed.author, { name: 'Kaivax, Community Manager' });
  assert.equal(embed.description, `Sample notes: a new beta build with fixes for casting animations & water sounds.…\n\n[Read the full notes](${embed.url})`);
  assert.deepEqual(embed.footer, { text: 'WoW: Forever Beta Discussion' });
  assert.equal(embed.timestamp, '2026-09-24T22:23:24.849Z');
  const update = forumEmbed({ kind: 'update', category: 'WoW: Forever Beta Discussion', post: { ...page[5], post_number: 7, url: 'javascript:alert(1)' } });
  assert.equal(update.title, 'Updated: WoW Forever Beta Development Notes – Updated September 24');
  assert.equal(update.url, 'https://us.forums.blizzard.com/en/wow/t/2360696/7', 'an odd link is rebuilt from the topic');
});

test('excerpts are plain text, at most 350 characters, cut at a word', () => {
  assert.equal(cleanExcerpt('Fixed *bold* _things_ &lt;now&gt; [link](x) &#8217;'), 'Fixed \\*bold\\* \\_things\\_ <now> \\[link\\](x) ’');
  assert.equal(cleanExcerpt('# Heading\n> quote'), '\\# Heading > quote');
  const long = cleanExcerpt('word '.repeat(200));
  assert.ok(long.length <= 350);
  assert.match(long, /word…$/);
  assert.equal(cleanExcerpt(''), '');
  assert.equal(cleanExcerpt('Controller navigation should now w&hellip;', true), 'Controller navigation should now w…', 'one ellipsis, not two');
  assert.equal(cleanExcerpt('Cut here...'), 'Cut here…');
  assert.equal(postUrl({ url: '/t/some-topic/123/4', topic_id: 123, post_number: 4 }), 'https://us.forums.blizzard.com/en/wow/t/some-topic/123/4');
});

test('more than five at once: the newest three, after one message listing the rest', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ kind: 'notes', category: 'WoW: Forever', post: post(30300200 + i) }));
  const messages = forumMessages(items);
  assert.deepEqual(messages.map(item => item.key), ['forum-more:30300200-30300203', 'forum:30300204', 'forum:30300205', 'forum:30300206']);
  assert.equal(messages[0].embed.title, '4 more Forever notes posts');
  assert.equal(messages[0].embed.description.split('\n').length, 4);
  assert.match(messages[0].embed.description, /^• \[WoW Forever Beta Development Notes 30300200\]\(https:\/\/us\.forums\.blizzard\.com\/en\/wow\/t\/notes\/2370200\/1\)/);
  assert.equal(forumMessages(items.slice(0, 5)).length, 5);
});
