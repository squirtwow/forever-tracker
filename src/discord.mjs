// Forever tracker Discord messages, by Squirt. All rights reserved.
// Embeds only, and nobody is pinged unless a role is set up for new builds.
import { pause, request } from './http.mjs';

export const COLOURS = { build: 0xe8a33d, ui: 0x7289da, notes: 0x148eff, live: 0x3ba55d };
const MAX_ATTEMPTS = 5;

// Only a real Discord webhook address, and never anything else.
export function validateWebhook(value) {
  if (!value) throw new Error('FOREVER_TRACKER_WEBHOOK is not set');
  let url;
  try { url = new URL(value); } catch { throw new Error('FOREVER_TRACKER_WEBHOOK is not a Discord webhook URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password
    || url.search || url.hash || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('FOREVER_TRACKER_WEBHOOK is not a Discord webhook URL');
  }
  url.searchParams.set('wait', 'true');
  return url;
}

// Text from Blizzard or GitHub shown as plain text, not as Discord formatting.
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([\\*_~`|[\]])/g, '\\$1').replace(/^([#>-])/gm, '\\$1');
}

// Cut at a word where possible, ending with an ellipsis.
export function cutText(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  let cut = value.slice(0, Math.max(0, limit - 1));
  const space = cut.lastIndexOf(' ');
  if (space > limit * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

// As many whole lines (or list items) as fit, then how many were left out.
export function fitLines(lines, limit, more = count => `…and ${count} more`, joiner = '\n') {
  const whole = lines.join(joiner);
  if (whole.length <= limit) return whole;
  const kept = [];
  for (const line of lines) {
    if ([...kept, line, more(lines.length - kept.length - 1)].join(joiner).length > limit) break;
    kept.push(line);
  }
  return cutText([...kept, more(lines.length - kept.length)].join(joiner), limit);
}

const embedSize = embed => [embed.title, embed.description, embed.author?.name, embed.footer?.text,
  ...(embed.fields || []).flatMap(field => [field.name, field.value])].reduce((sum, text) => sum + (text?.length || 0), 0);

// Keeps an embed inside Discord's limits: 256 for titles and field names, 4096
// for the description, 1024 per field and 6000 in total.
export function finishEmbed(embed) {
  const out = { ...embed };
  if (out.title) out.title = cutText(out.title, 256);
  if (out.author?.name) out.author = { ...out.author, name: cutText(out.author.name, 256) };
  if (out.footer?.text) out.footer = { ...out.footer, text: cutText(out.footer.text, 2048) };
  if (out.fields?.length) {
    out.fields = out.fields.slice(0, 25).map(field => ({ name: cutText(field.name, 256), value: cutText(field.value, 1024) }));
  } else {
    delete out.fields;
  }
  if (out.description) out.description = cutText(out.description, 4096);
  // Over 6000 in total: the last fields go first, then the description is cut.
  while (embedSize(out) > 6000 && out.fields?.length) out.fields.pop();
  if (!out.fields?.length) delete out.fields;
  const over = embedSize(out) - 6000;
  if (over > 0 && out.description) out.description = cutText(out.description, Math.max(1, out.description.length - over));
  return out;
}

// One message. A role is only pinged when one is set up (new builds only).
export function message(embed, { ping = null } = {}) {
  const payload = { allowed_mentions: { parse: [] }, embeds: [finishEmbed(embed)] };
  if (ping) {
    payload.content = `<@&${ping}>`;
    payload.allowed_mentions.roles = [ping];
  }
  return payload;
}

export async function sendDiscord(webhook, payload, { fetcher, sleep = pause } = {}) {
  const response = await request(webhook, {
    label: 'Discord', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), fetcher, sleep, maxWaitMs: 60000,
  });
  if (!response.ok) {
    const error = new Error(`Discord: HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  let reply = null;
  try { reply = await response.json(); } catch { /* checked below */ }
  if (typeof reply?.id !== 'string') throw new Error('Discord did not acknowledge the message');
}

// Sends the outbox oldest first, a second apart, saving after each message so
// a crash never loses or repeats one. A failed message stays for the next run
// and is dropped after five tries; one Discord refuses as malformed (400) is
// dropped straight away. In a dry run the messages are printed instead.
export async function sendOutbox(state, { send, save = async () => {}, dryRun = false, print = console.log, sleep = pause, log = console.log }) {
  let sent = 0, tried = 0, failed = false;
  while (state.outbox.length) {
    const item = state.outbox[0];
    if (dryRun) {
      print(`--- Would post (${item.key}) ---\n${JSON.stringify(item.payload, null, 2)}`);
      state.outbox.shift();
      sent++;
      continue;
    }
    if (tried++) await sleep(1000);
    try {
      await send(item.payload);
    } catch (error) {
      failed = true;
      item.attempts = (item.attempts || 0) + 1;
      log(`${error.message} (${item.key}, try ${item.attempts} of ${MAX_ATTEMPTS})`);
      const malformed = error.status === 400;
      if (malformed || item.attempts >= MAX_ATTEMPTS) {
        state.outbox.shift();
        log(`Dropped ${item.key}.`);
      }
      await save();
      if (malformed) continue;
      break;
    }
    state.outbox.shift();
    sent++;
    await save();
  }
  return { sent, failed };
}
