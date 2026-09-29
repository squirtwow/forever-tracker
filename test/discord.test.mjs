// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cutText, escapeMarkdown, finishEmbed, fitLines, message, sendDiscord, sendOutbox, validateWebhook,
} from '../src/discord.mjs';

const HOOK = 'https://discord.com/api/webhooks/123456/test_TOKEN-value';

test('only a real Discord webhook, and the address never shows in errors', () => {
  const url = validateWebhook(HOOK);
  assert.equal(url.searchParams.get('wait'), 'true');
  assert.throws(() => validateWebhook(undefined), /^Error: FOREVER_TRACKER_WEBHOOK is not set$/);
  assert.throws(() => validateWebhook(''), /FOREVER_TRACKER_WEBHOOK is not set/);
  for (const bad of ['not a url', 'http://discord.com/api/webhooks/1/abc', 'https://evil.example/api/webhooks/1/abc',
    `${HOOK}?thread_id=1`, 'https://discord.com/api/webhooks/1/abc/extra', 'https://user:pw@discord.com/api/webhooks/1/abc']) {
    assert.throws(() => validateWebhook(bad), error => error.message === 'FOREVER_TRACKER_WEBHOOK is not a Discord webhook URL' && !error.message.includes(bad));
  }
});

test('messages never ping anyone unless a role is set up', () => {
  const plain = message({ title: 'Hi' });
  assert.deepEqual(plain.allowed_mentions, { parse: [] });
  assert.equal(plain.content, undefined);
  const pinged = message({ title: 'Hi' }, { ping: '112233445566' });
  assert.equal(pinged.content, '<@&112233445566>');
  assert.deepEqual(pinged.allowed_mentions, { parse: [], roles: ['112233445566'] });
});

test('text helpers', () => {
  assert.equal(escapeMarkdown('a*b_c~d`e|f[g]h\\i'), 'a\\*b\\_c\\~d\\`e\\|f\\[g\\]h\\\\i');
  assert.equal(escapeMarkdown('- item\n# head\n> quote'), '\\- item\n\\# head\n\\> quote');
  assert.equal(cutText('short', 10), 'short');
  assert.equal(cutText('one two three four five', 14), 'one two three…');
  assert.equal(fitLines(['a', 'b'], 10), 'a\nb');
  assert.equal(fitLines(['aaaa', 'bbbb', 'cccc', 'dddd'], 16), 'aaaa\n…and 3 more');
  assert.equal(fitLines(['aa', 'bb', 'cc', 'dd', 'ee', 'ff'], 19, count => `+${count} more`, ', '), 'aa, bb, cc, +3 more');
});

test('embeds are kept inside every Discord limit', () => {
  const embed = finishEmbed({
    title: 'T'.repeat(300), description: 'd '.repeat(3000), author: { name: 'A'.repeat(300) }, footer: { text: 'f' },
    fields: Array.from({ length: 30 }, () => ({ name: 'N'.repeat(300), value: 'v '.repeat(700) })),
  });
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.author.name.length <= 256);
  assert.ok(embed.description.length <= 4096 && embed.description.length > 4000);
  assert.equal(embed.fields.length, 1, 'the last fields give way first');
  for (const field of embed.fields) assert.ok(field.name.length <= 256 && field.value.length <= 1024);
  const total = embed.title.length + embed.description.length + embed.author.name.length + embed.footer.text.length
    + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(total <= 6000);
  const noFields = finishEmbed({ title: 'T'.repeat(256), description: 'd '.repeat(3000), footer: { text: 'f'.repeat(2048) } });
  assert.ok(256 + noFields.description.length + 2048 <= 6000, 'then the description is cut');
  assert.equal(finishEmbed({ title: 'x', fields: [] }).fields, undefined);
});

function discord(...answers) {
  const posted = [];
  const fetcher = async (url, init) => {
    posted.push({ url: String(url), init });
    const answer = answers[Math.min(posted.length, answers.length) - 1];
    return typeof answer === 'number'
      ? new Response('{"message":"no","retry_after":0.5}', { status: answer, headers: { 'Retry-After': '1' } })
      : Response.json(answer);
  };
  const waits = [];
  return { posted, waits, fetcher, sleep: async ms => { waits.push(ms); } };
}

test('a Discord post waits for the message and retries after a rate limit', async () => {
  const web = discord(429, { id: '1' });
  await sendDiscord(validateWebhook(HOOK), { embeds: [] }, web);
  assert.equal(web.posted.length, 2);
  assert.equal(web.posted[0].url, `${HOOK}?wait=true`);
  assert.equal(web.posted[0].init.method, 'POST');
  assert.equal(web.posted[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(web.waits, [1000]);
});

test('Discord errors name the status, never the webhook', async () => {
  for (const [answers, pattern] of [[[500], /^Discord: HTTP 500$/], [[404], /^Discord: HTTP 404$/], [[{}], /did not acknowledge/]]) {
    const web = discord(...answers);
    await assert.rejects(sendDiscord(validateWebhook(HOOK), { embeds: [] }, web), error => pattern.test(error.message) && !error.message.includes('test_TOKEN'));
    if (answers[0] === 500) assert.equal(web.posted.length, 1, 'a post is not repeated after a server error');
  }
});

const outbox = keys => ({ outbox: keys.map(key => ({ key, payload: { embeds: [{ title: key }] }, attempts: 0 })) });

test('the outbox is sent in order, a second apart, saving after each', async () => {
  const state = outbox(['a', 'b', 'c']);
  const sent = [], saves = [], waits = [];
  const result = await sendOutbox(state, {
    send: async payload => { sent.push(payload.embeds[0].title); },
    save: async () => { saves.push(state.outbox.length); }, sleep: async ms => { waits.push(ms); }, log: () => {},
  });
  assert.deepEqual(result, { sent: 3, failed: false });
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.deepEqual(saves, [2, 1, 0]);
  assert.deepEqual(waits, [1000, 1000]);
});

test('a failed message waits for the next run and is dropped after five tries', async () => {
  const state = outbox(['a', 'b']);
  const logs = [];
  const failing = { send: async () => { throw Object.assign(new Error('Discord: HTTP 503'), { status: 503 }); }, sleep: async () => {}, log: line => logs.push(line) };
  for (let run = 1; run <= 4; run++) {
    assert.deepEqual(await sendOutbox(state, failing), { sent: 0, failed: true });
    assert.equal(state.outbox[0].attempts, run);
    assert.equal(state.outbox.length, 2);
  }
  await sendOutbox(state, failing);
  assert.deepEqual(state.outbox.map(item => item.key), ['b']);
  assert.match(logs.at(-1), /^Dropped a\.$/);
  assert.match(logs[0], /^Discord: HTTP 503 \(a, try 1 of 5\)$/);
});

test('a message Discord refuses as malformed is dropped at once and the rest still go', async () => {
  const state = outbox(['bad', 'good']);
  const sent = [];
  const result = await sendOutbox(state, {
    send: async payload => {
      if (payload.embeds[0].title === 'bad') throw Object.assign(new Error('Discord: HTTP 400'), { status: 400 });
      sent.push(payload.embeds[0].title);
    },
    sleep: async () => {}, log: () => {},
  });
  assert.deepEqual(result, { sent: 1, failed: true });
  assert.deepEqual(sent, ['good']);
  assert.deepEqual(state.outbox, []);
});

test('a dry run prints the messages and sends nothing', async () => {
  const state = outbox(['a']);
  const printed = [];
  const result = await sendOutbox(state, { dryRun: true, print: text => printed.push(text), send: async () => assert.fail('sent') });
  assert.deepEqual(result, { sent: 1, failed: false });
  assert.match(printed[0], /^--- Would post \(a\) ---\n\{/);
});
