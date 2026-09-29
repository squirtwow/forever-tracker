// WoW Forever patch notes and hotfixes from Blizzard staff on the US WoW
// forums, by Squirt. All rights reserved. Reads the public Blue Tracker feed
// (staff posts only) and keeps just Forever notes: a new notes topic, or a
// standalone staff update inside one.
import { COLOURS, cutText, escapeMarkdown, fitLines } from './discord.mjs';

export const FORUM = 'https://us.forums.blizzard.com/en/wow';
export const trackerUrl = before => `${FORUM}/groups/blizzard-tracker/posts.json${before ? `?before_post_id=${before}` : ''}`;

const NOTES = /\b(patch notes|hotfix(es)?|development notes|dev notes|client update|update notes|release notes|change ?log)\b|\bpatch\b.*\bnotes\b/i;
const KNOWN_ISSUES = /\bknown issues\b/i;
const ANNOUNCEMENT = /\bposted\b/i; // "Development Notes Posted" only links to the notes
const FOREVER = /\bforever\b/i;
const MAX_PAGES = 3, SEEN = 200, TOPICS = 200;
const CATEGORY_DAYS = 7;
const FLOOD = 5, KEEP = 3;
const MISSING = [403, 404];

export function isNotesTitle(title, knownIssues = false) {
  if (typeof title !== 'string' || ANNOUNCEMENT.test(title)) return false;
  return NOTES.test(title) || (knownIssues && KNOWN_ISSUES.test(title));
}

const validPost = post => Number.isInteger(post?.id) && Number.isInteger(post.topic_id)
  && Number.isInteger(post.post_number) && typeof post.topic_title === 'string';

export function postUrl(post) {
  const path = typeof post.url === 'string' && /^\/t\/[\w%-]+\/\d+(\/\d+)?$/.test(post.url)
    ? post.url : `/t/${post.topic_id}/${post.post_number}`;
  return `${FORUM}${path}`;
}

// Staff posts, oldest first: the newest page, then older pages until the
// last post already seen (at most three pages).
async function fetchPosts(highWater, get) {
  const posts = new Map();
  let before = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await get(trackerUrl(before));
    if (!Array.isArray(data?.posts)) throw new Error('Forum: unexpected response');
    const list = data.posts.filter(validPost);
    if (!list.length) {
      if (page === 0) throw new Error('Forum: no staff posts listed');
      break;
    }
    for (const post of list) posts.set(post.id, post);
    const lowest = Math.min(...list.map(post => post.id));
    if (highWater != null && lowest <= highWater) break;
    before = lowest;
  }
  return [...posts.values()].sort((a, b) => a.id - b.id);
}

// Whether a category, or its parent, is a Forever one. Names are kept for a
// week, so new Forever subforums are picked up on their own.
async function category(id, forum, ctx, depth = 0) {
  if (!Number.isInteger(id)) return { name: null, forever: false };
  const saved = forum.categories[id];
  if (saved && ctx.now - (saved.checked || 0) < CATEGORY_DAYS * 86400000) return saved;
  const data = await ctx.get(`${FORUM}/c/${id}/show.json`, { missing: MISSING });
  const found = data?.category;
  let info = { name: null, forever: false, checked: ctx.now };
  if (typeof found?.name === 'string') {
    const parent = depth < 2 && Number.isInteger(found.parent_category_id)
      ? await category(found.parent_category_id, forum, ctx, depth + 1) : null;
    info = { name: found.name, forever: FOREVER.test(found.name) || Boolean(parent?.forever), checked: ctx.now };
  }
  forum.categories[id] = info;
  return info;
}

// Whether staff started the topic (its first post is by staff).
async function staffTopic(topicId, forum, ctx) {
  if (forum.notesTopics[topicId]) return true;
  if (forum.otherTopics.includes(topicId)) return false;
  const first = await ctx.get(`${FORUM}/posts/by_number/${topicId}/1.json`, { missing: MISSING });
  if (first?.staff === true) return true;
  forum.otherTopics.push(topicId);
  return false;
}

// A reply that stands on its own: not a reply to someone and not a quote.
async function standalone(postId, ctx) {
  const post = await ctx.get(`${FORUM}/posts/${postId}.json`, { missing: MISSING });
  return Boolean(post) && post.reply_to_post_number == null && !/^\s*\[quote/i.test(String(post.raw ?? ''));
}

// Cheap checks first; the forum is only asked more when a post could be notes.
async function classify(post, forum, ctx) {
  if (post.post_type !== 1 || !isNotesTitle(post.topic_title, ctx.knownIssues)) return null;
  const place = await category(post.category_id, forum, ctx);
  if (!place.forever && !FOREVER.test(post.topic_title)) return null;
  if (post.post_number === 1) {
    forum.notesTopics[post.topic_id] = post.topic_title;
    return { kind: 'notes', post, category: place.name };
  }
  if (ctx.first) return null;
  if (!(await staffTopic(post.topic_id, forum, ctx)) || !(await standalone(post.id, ctx))) return null;
  forum.notesTopics[post.topic_id] = post.topic_title;
  return { kind: 'update', post, category: place.name };
}

const newestKeys = (object, limit) => Object.fromEntries(Object.entries(object)
  .sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, limit));

// Posts are new when they haven't been seen and are newer than the oldest one
// remembered. The first time, everything is only recorded.
export async function checkForum(previous, { get, knownIssues = false, now = Date.now() }) {
  const saved = previous ? structuredClone(previous) : {};
  const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const numbers = value => (Array.isArray(value) ? value.filter(Number.isInteger) : []);
  const forum = {
    highWater: Number.isInteger(saved.highWater) ? saved.highWater : null,
    seen: numbers(saved.seen), notesTopics: object(saved.notesTopics), otherTopics: numbers(saved.otherTopics),
    categories: object(saved.categories),
  };
  const first = !Number.isInteger(forum.highWater);
  const ctx = { get, knownIssues, now, first };
  const posts = await fetchPosts(first ? null : forum.highWater, get);
  const seen = new Set(forum.seen);
  const floor = forum.seen.length ? Math.min(...forum.seen) : forum.highWater;
  const fresh = first ? posts : posts.filter(post => !seen.has(post.id) && post.id > floor);
  const items = [];
  for (const post of fresh) {
    const item = await classify(post, forum, ctx);
    if (item) items.push(item);
  }
  forum.highWater = Math.max(forum.highWater ?? 0, ...posts.map(post => post.id));
  forum.seen = [...new Set([...posts.map(post => post.id), ...forum.seen])].sort((a, b) => b - a).slice(0, SEEN);
  forum.notesTopics = newestKeys(forum.notesTopics, TOPICS);
  forum.otherTopics = forum.otherTopics.slice(-TOPICS);
  const latest = items.filter(item => item.kind === 'notes').at(-1);
  return {
    entry: forum,
    first,
    checked: fresh.length,
    events: first ? [] : items,
    latest: latest ? { title: latest.post.topic_title, url: postUrl(latest.post) } : null,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…' };
function decode(match, name) {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
  }
  return ENTITIES[name.toLowerCase()] ?? match;
}

// The forum's plain text excerpt, at most 350 characters, cut at a word.
export function cleanExcerpt(text, truncated = false, limit = 350) {
  let plain = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, decode)
    .replace(/\s+/g, ' ').trim();
  // The forum ends a cut excerpt with its own ellipsis; keep just one.
  if (/(…|\.\.\.)$/.test(plain)) {
    plain = plain.replace(/\s*(…|\.\.\.)$/, '');
    truncated = true;
  }
  if (!plain) return '';
  if (plain.length > limit) return escapeMarkdown(cutText(plain, limit));
  return escapeMarkdown(plain) + (truncated ? '…' : '');
}

const titleOf = item => (item.kind === 'update' ? `Updated: ${item.post.topic_title}` : item.post.topic_title);

export function forumEmbed(item) {
  const { post } = item;
  const url = postUrl(post);
  const excerpt = cleanExcerpt(post.excerpt, post.truncated === true);
  const author = [post.username, post.user_title].filter(value => typeof value === 'string' && value).join(', ');
  const embed = {
    title: titleOf(item),
    url,
    color: COLOURS.notes,
    description: `${excerpt ? `${excerpt}\n\n` : ''}[Read the full notes](${url})`,
  };
  if (author) embed.author = { name: author };
  if (item.category) embed.footer = { text: item.category };
  if (!Number.isNaN(Date.parse(post.created_at))) embed.timestamp = new Date(post.created_at).toISOString();
  return embed;
}

// One message per post. More than five at once: the newest three, after one
// message listing the rest.
export function forumMessages(items) {
  const messages = items.map(item => ({ key: `forum:${item.post.id}`, embed: forumEmbed(item) }));
  if (messages.length <= FLOOD) return messages;
  const older = items.slice(0, -KEEP);
  const lines = older.map(item => `• [${escapeMarkdown(titleOf(item))}](${postUrl(item.post)})`);
  return [{
    key: `forum-more:${older[0].post.id}-${older.at(-1).post.id}`,
    embed: {
      title: `${older.length} more Forever notes posts`,
      color: COLOURS.notes,
      description: fitLines(lines, 3500),
      footer: { text: 'Blizzard forums' },
    },
  }, ...messages.slice(-KEEP)];
}
