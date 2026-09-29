// Forever tracker web requests, by Squirt. All rights reserved.
// Blizzard and GitHub are only ever read (GET). Errors name the service and the
// HTTP status, never the address, so the webhook URL can't end up in a log.

export const USER_AGENT = 'forever-tracker by Squirt';
export const pause = ms => new Promise(done => setTimeout(done, ms));

// One request with a 30 second timeout. Reads are tried up to three times after
// rate limits, server errors and network failures. A post is only tried again
// after a rate limit, so one run never sends Discord the same message twice.
export async function request(url, {
  label, method = 'GET', headers = {}, body, fetcher = fetch, sleep = pause, tries = 3, maxWaitMs = 20000,
} = {}) {
  const read = method === 'GET';
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetcher(url, {
        method, body, headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(30000),
      });
    } catch {
      if (read && attempt < tries) { await sleep(2000 * attempt); continue; }
      throw new Error(`${label}: network failure or timeout`);
    }
    const retry = response.status === 429 || (read && response.status >= 500);
    if (!retry || attempt >= tries) return response;
    const after = Number(response.headers.get('retry-after'));
    await sleep(Math.min(maxWaitMs, after > 0 ? after * 1000 : 2000 * attempt));
  }
}

export async function readBody(response, label, json = true) {
  try {
    return json ? await response.json() : await response.text();
  } catch {
    throw new Error(`${label}: unreadable response`);
  }
}

// The body of a successful read. Statuses listed in `missing` (such as 404)
// give null instead of an error.
export async function get(url, label, { json = true, missing = [], headers = {}, ...options } = {}) {
  const response = await request(url, {
    ...options, label, headers: { Accept: json ? 'application/json' : 'text/plain', ...headers },
  });
  if (missing.includes(response.status)) return null;
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return readBody(response, label, json);
}
