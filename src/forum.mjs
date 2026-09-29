// WoW Forever patch notes and hotfixes from Blizzard staff on the US WoW
// forums, by Squirt. All rights reserved. Reads the public Blue Tracker feed
// (staff posts only) and keeps just Forever notes: a new notes topic, a staff
// update inside one, or the notes a "Notes Posted" announcement points to.
import { COLOURS, cutText, escapeMarkdown, fitLines } from './discord.mjs';

export const FORUM = 'https://us.forums.blizzard.com/en/wow';
export const trackerUrl = before => `${FORUM}/groups/blizzard-tracker/posts.json${before ? `?before_post_id=${before}` : ''}`;

const NOTES = new RegExp([
  '\\b(patch|development|dev|build|release|update) notes\\b', '\\bpatch\\b.*\\bnotes\\b', '\\bhotfix(es)?\\b', '\\bchange ?log\\b',
  '\\b(beta|build|ptr|client) update\\b', '\\bnew (beta |client )?build\\b',
].join('|'), 'i');
const KNOWN_ISSUES = /\bknown issues\b/i;
const ANNOUNCEMENT = /\bposted\b/i; // "Development Notes Posted" only points to the notes
const FOREVER = /\bforever\b/i;
// Written like notes: a list, a heading, or a bold line of its own. Or a short
// fix announcement.
const NOTES_BODY = /^[ \t]*(?:[*+-]|\d+\.)[ \t]+\S|^#{1,6}[ \t]+\S|^\*\*[^*\n]+\*\*:?[ \t]*$|^.+\n(?:-{2,}|={2,})[ \t]*$/m;
const FIX_WORDS = /\b(hotfix(es|ed)?|fixed|resolved)\b/i;
const MAX_PAGES = 3, SEEN = 200, TOPICS = 200;
const HOUR = 3600000, DAY = 24 * HOUR;
const CATEGORY_DAYS = 7, TWIN_DAYS = 7;
const EDIT_GRACE = HOUR; // a quick fix just after the notes went up isn't new notes
const FLOOD = 5, KEEP = 3;
// Only a 404 means "not there". Anything else, such as a 403 from a brief
// block, fails the forum check, so its posts are looked at again next run.
const MISSING = [404];

export function isNotesTitle(title, knownIssues = false) {
  if (typeof title !== 'string' || ANNOUNCEMENT.test(title)) return false;
  return NOTES.test(title) || (knownIssues && KNOWN_ISSUES.test(title));
}

// "Beta is Up - Development Notes Posted".
export function isAnnouncement(title, knownIssues = false) {
  return typeof title === 'string' && ANNOUNCEMENT.test(title)
    && (NOTES.test(title) || (knownIssues && KNOWN_ISSUES.test(title)));
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
// week, so new Forever subforums are picked up on their own. A category that
// isn't found is not saved, so it is asked again next time.
async function category(id, forum, ctx, depth = 0) {
  if (!Number.isInteger(id)) return { name: null, forever: false };
  const saved = forum.categories[id];
  if (saved?.name && ctx.now - (saved.checked || 0) < CATEGORY_DAYS * DAY) return saved;
  const found = (await ctx.get(`${FORUM}/c/${id}/show.json`, { missing: MISSING }))?.category;
  if (typeof found?.name !== 'string') return { name: null, forever: false };
  const parent = depth < 2 && Number.isInteger(found.parent_category_id)
    ? await category(found.parent_category_id, forum, ctx, depth + 1) : null;
  const info = { name: found.name, forever: FOREVER.test(found.name) || Boolean(parent?.forever), checked: ctx.now };
  forum.categories[id] = info;
  return info;
}

// Whether staff started the topic (its first post is by staff). Only a first
// post that was actually read is remembered as "not staff".
async function staffTopic(topicId, forum, ctx) {
  if (forum.notesTopics[topicId]) return true;
  if (forum.otherTopics.includes(topicId)) return false;
  const first = await ctx.get(`${FORUM}/posts/by_number/${topicId}/1.json`, { missing: MISSING });
  if (!Number.isInteger(first?.id)) return false;
  if (first.staff === true) return true;
  forum.otherTopics.push(topicId);
  return false;
}

// A staff update: not an answer to someone, not a quote, and written like
// notes rather than a chat reply.
async function isUpdate(postId, ctx) {
  const post = await ctx.get(`${FORUM}/posts/${postId}.json`, { missing: MISSING });
  const raw = String(post?.raw ?? '');
  return Boolean(post) && post.reply_to_post_number == null && !/^\s*\[quote/i.test(raw)
    && (NOTES_BODY.test(raw) || FIX_WORDS.test(raw));
}

// Topics on this forum that a post links to or quotes, at most three.
export function linkedTopics(raw, own) {
  const ids = [];
  const links = /us\.forums\.blizzard\.com\/en\/wow\/t\/(?:[^\s/?#)\]]*[^\d\s/?#)\]][^\s/?#)\]]*\/)?(\d+)|\btopic:(\d+)/g;
  for (const match of String(raw ?? '').matchAll(links)) {
    const id = Number(match[1] || match[2]);
    if (id !== own && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 3);
}

const plainTitle = title => String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const remember = (forum, topicId, title, now) => { forum.notesTopics[topicId] = { title, at: now }; };

// The same notes as another topic within a week: news is often posted to more
// than one forum at once.
function twin(forum, post, now) {
  const title = plainTitle(post.topic_title);
  return Object.entries(forum.notesTopics).some(([id, topic]) => Number(id) !== post.topic_id
    && plainTitle(topic.title) === title && now - topic.at < TWIN_DAYS * DAY);
}

// An announcement such as "Development Notes Posted" points to the notes.
// Those are posted unless the tracker already has them as they are now: same
// title, and not edited since (Blizzard sometimes updates notes in place). An
// announcement that links nothing is posted itself, unless notes came in the
// last 12 hours.
async function announced(post, place, forum, ctx) {
  const full = await ctx.get(`${FORUM}/posts/${post.id}.json`, { missing: MISSING });
  if (!full) return [];
  const ids = linkedTopics(full.raw, post.topic_id);
  if (!ids.length) {
    const recent = Object.values(forum.notesTopics).some(topic => ctx.now - topic.at < 12 * HOUR);
    return recent ? [] : [{ kind: 'notes', post, category: place.name }];
  }
  const items = [];
  for (const id of ids) {
    const topic = await ctx.get(`${FORUM}/t/${id}.json`, { missing: MISSING });
    const first = topic?.post_stream?.posts?.[0];
    if (!isNotesTitle(topic?.title, ctx.knownIssues) || first?.post_number !== 1 || first.staff !== true) continue;
    const where = await category(topic.category_id, forum, ctx);
    if (!where.forever && !FOREVER.test(topic.title)) continue;
    const known = forum.notesTopics[id];
    if (known && known.title === topic.title && !(Date.parse(first.updated_at) - known.at > EDIT_GRACE)) continue;
    remember(forum, id, topic.title, ctx.now);
    items.push({
      kind: known ? 'update' : 'notes', key: `forum:${post.id}:${id}`, category: where.name,
      post: {
        id: first.id, topic_id: id, post_number: 1, topic_title: topic.title, url: typeof topic.slug === 'string' ? `/t/${topic.slug}/${id}/1` : null,
        username: first.username, user_title: first.user_title, excerpt: first.cooked, truncated: false,
        created_at: first.updated_at || first.created_at,
      },
    });
  }
  return items;
}

// Cheap checks first; the forum is only asked more when a post could be notes.
async function classify(post, forum, ctx) {
  const title = post.topic_title;
  const announcement = post.post_number === 1 && isAnnouncement(title, ctx.knownIssues);
  if (post.post_type !== 1 || (!announcement && !isNotesTitle(title, ctx.knownIssues))) return [];
  const place = await category(post.category_id, forum, ctx);
  if (!place.forever && !FOREVER.test(title)) return [];
  if (announcement) return ctx.first ? [] : announced(post, place, forum, ctx);
  if (post.post_number === 1) {
    if (twin(forum, post, ctx.now)) return [];
    remember(forum, post.topic_id, title, ctx.now);
    return [{ kind: 'notes', post, category: place.name }];
  }
  if (ctx.first) return [];
  if (!(await staffTopic(post.topic_id, forum, ctx)) || !(await isUpdate(post.id, ctx))) return [];
  remember(forum, post.topic_id, title, ctx.now);
  return [{ kind: 'update', post, category: place.name }];
}

const newestKeys = (object, limit) => Object.fromEntries(Object.entries(object)
  .sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, limit));

// Posts are new when they haven't been seen and are newer than the oldest one
// remembered. The first time, everything is only recorded.
export async function checkForum(previous, { get, knownIssues = false, now = Date.now() }) {
  const saved = previous ? structuredClone(previous) : {};
  const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const numbers = value => (Array.isArray(value) ? value.filter(Number.isInteger) : []);
  const topics = Object.entries(object(saved.notesTopics))
    .filter(([, topic]) => typeof topic?.title === 'string' && Number.isFinite(topic.at));
  const forum = {
    highWater: Number.isInteger(saved.highWater) ? saved.highWater : null,
    seen: numbers(saved.seen), notesTopics: Object.fromEntries(topics), otherTopics: numbers(saved.otherTopics),
    categories: object(saved.categories),
  };
  const first = !Number.isInteger(forum.highWater);
  const ctx = { get, knownIssues, now, first };
  const posts = await fetchPosts(first ? null : forum.highWater, get);
  const seen = new Set(forum.seen);
  const floor = forum.seen.length ? Math.min(...forum.seen) : forum.highWater;
  const fresh = first ? posts : posts.filter(post => !seen.has(post.id) && post.id > floor);
  const items = [];
  for (const post of fresh) items.push(...await classify(post, forum, ctx));
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
  const messages = items.map(item => ({ key: item.key || `forum:${item.post.id}`, embed: forumEmbed(item) }));
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
