// WoW Forever builds on Blizzard's public patch server, by Squirt. All rights reserved.
// Only a new version or build number is posted. CDNConfig changes whenever any
// Classic product updates, and a new BuildConfig on the same build is a repack,
// so neither is posted.
import { COLOURS } from './discord.mjs';

export const DEFAULT_PRODUCTS = ['wow_classic_beta'];

// The same table from two addresses; the second is only used if the first fails.
export const versionUrls = product => [
  `https://us.version.battle.net/v2/products/${product}/versions`,
  `http://us.patch.battle.net:1119/${product}/versions`,
];

// "Region!STRING:0|BuildConfig!HEX:16|..." then "## seqn = N" then one row per region.
export function parseVersions(text) {
  let columns = null, seqn = null;
  const rows = [];
  for (const line of String(text).split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const sequence = line.match(/^##\s*seqn\s*=\s*(\d+)/i);
    if (sequence) { seqn = Number(sequence[1]); continue; }
    if (line.startsWith('#')) continue;
    const cells = line.split('|').map(cell => cell.trim());
    if (!columns) { columns = cells.map(cell => cell.split('!')[0].toLowerCase()); continue; }
    const row = Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? '']));
    const buildId = Number(row.buildid);
    if (!/^[a-z]{2,4}$/i.test(row.region) || !Number.isInteger(buildId) || buildId <= 0
      || !/^\d+(\.\d+){2,3}$/.test(row.versionsname)) continue;
    rows.push({ region: row.region.toLowerCase(), buildId, version: row.versionsname, buildConfig: row.buildconfig || '' });
  }
  return { seqn, rows };
}

// The newest build in any region, and what each region has.
export function summariseRows(rows) {
  const newest = rows.reduce((best, row) => (row.buildId > best.buildId ? row : best));
  return {
    version: newest.version, buildId: newest.buildId, buildConfig: newest.buildConfig,
    regions: Object.fromEntries(rows.map(row => [row.region, row.version])),
  };
}

export function compareBuilds(previous, current) {
  if (current.buildId === previous.buildId && current.version === previous.version) {
    return current.buildConfig !== previous.buildConfig ? 'repack' : 'same';
  }
  return current.buildId < previous.buildId ? 'rollback' : 'new';
}

// "On us, eu." then "Still 1.60.1.70009: kr, tw." for any region behind.
export function regionText(build) {
  const have = [], behind = new Map();
  for (const [region, version] of Object.entries(build.regions || {})) {
    if (version === build.version) have.push(region);
    else behind.set(version, [...(behind.get(version) || []), region]);
  }
  const parts = have.length ? [`On ${have.join(', ')}.`] : [];
  for (const [version, regions] of behind) parts.push(`Still ${version}: ${regions.join(', ')}.`);
  return parts.join(' ');
}

// A table that fails, is empty, or is older than the last one seen (its seqn
// went down) never replaces the saved build.
export async function checkPatch(previous, product, { fetchText }) {
  let parsed = null, lastError = null;
  for (const url of versionUrls(product)) {
    try {
      const result = parseVersions(await fetchText(url));
      if (result.rows.length) { parsed = result; break; }
      lastError = new Error('Patch server: no builds listed');
    } catch (error) {
      lastError = error;
    }
  }
  if (!parsed) throw lastError;
  const current = { ...summariseRows(parsed.rows), seqn: parsed.seqn };
  if (!previous?.version) return { entry: current, first: true };
  const kind = compareBuilds(previous, current);
  const stale = Number.isInteger(previous.seqn) && Number.isInteger(current.seqn) && current.seqn < previous.seqn;
  if (stale && kind !== 'new') return { entry: previous, kind: 'stale' };
  if (kind === 'same' || kind === 'repack') return { entry: current, kind };
  return { entry: current, kind, event: { product, previous, current, kind } };
}

export function buildEmbed({ product, previous, current, kind }, now = new Date()) {
  const forever = /^1\./.test(current.version);
  const what = forever ? 'Forever build' : `${product} build`;
  const lines = [`Was ${previous.version}. ${regionText(current)}`.trim()];
  if (!forever) lines.push(`Heads up: ${product} no longer has a 1.x version, so it may not be WoW Forever any more.`);
  return {
    title: kind === 'rollback' ? `${what} rolled back: ${current.version}` : `New ${what}: ${current.version}`,
    description: lines.join('\n'),
    color: COLOURS.build,
    footer: { text: `Blizzard patch server, ${product}` },
    timestamp: now.toISOString(),
  };
}
