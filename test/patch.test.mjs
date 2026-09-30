// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildEmbed, checkPatch, compareBuilds, parseVersions, regionText, summariseRows } from '../src/patch.mjs';

const table = await readFile(new URL('./fixtures/versions.txt', import.meta.url), 'utf8');
const saved = { ...summariseRows(parseVersions(table).rows), seqn: 4045314 };
// The live table with some regions moved to another build.
const withBuild = (regions, version, { seqn = 4045400, config = 'aaaa' } = {}) => table.split('\n').map(line => {
  if (line.startsWith('## seqn')) return `## seqn = ${seqn}`;
  const cells = line.split('|');
  if (!regions.includes(cells[0])) return line;
  cells[1] = config; cells[4] = version.split('.').at(-1); cells[5] = version;
  return cells.join('|');
}).join('\n');
const serve = (...bodies) => {
  const asked = [];
  return { asked, fetchText: async url => { asked.push(url); const body = bodies[asked.length - 1]; if (body instanceof Error) throw body; return body; } };
};

test('reads the live versions table by column name', () => {
  const { seqn, rows } = parseVersions(table);
  assert.equal(seqn, 4045314);
  assert.deepEqual(rows.map(row => row.region), ['us', 'eu', 'kr', 'tw']);
  assert.deepEqual(rows[0], { region: 'us', buildId: 70009, version: '1.60.1.70009', buildConfig: '05215079e3905ef5922ae0b03ffefb73' });
});

test('an error page or a malformed table has no builds', () => {
  assert.deepEqual(parseVersions("No matched data for selector 'v2/products/wow_classic_beta/versions'").rows, []);
  assert.deepEqual(parseVersions('Region!STRING:0|BuildId!DEC:4|VersionsName!String:0\nus|abc|1.60.1\neu||').rows, []);
  assert.deepEqual(parseVersions('').rows, []);
});

test('the newest build in any region, and the regions still behind', () => {
  const current = summariseRows(parseVersions(withBuild(['us', 'eu'], '1.60.1.70010')).rows);
  assert.equal(current.version, '1.60.1.70010');
  assert.equal(current.buildId, 70010);
  assert.equal(regionText(current), 'On US, EU. Still 1.60.1.70009: KR, TW.');
  assert.equal(regionText(saved), 'On US, EU, KR, TW.');
});

test('only a new version or build number counts as a new build', () => {
  const next = { ...saved, buildId: 70010, version: '1.60.1.70010' };
  assert.equal(compareBuilds(saved, { ...saved }), 'same');
  assert.equal(compareBuilds(saved, { ...saved, buildConfig: 'other' }), 'repack');
  assert.equal(compareBuilds(saved, next), 'new');
  assert.equal(compareBuilds(next, saved), 'rollback');
  assert.equal(compareBuilds(saved, { ...saved, version: '1.60.2.70009' }), 'new');
});

test('the first time, the build is only recorded', async () => {
  const result = await checkPatch(undefined, 'wow_classic_beta', serve(table));
  assert.equal(result.first, true);
  assert.equal(result.event, undefined);
  assert.equal(result.entry.version, '1.60.1.70009');
  assert.equal(result.entry.seqn, 4045314);
});

test('a new build, once; a repack or the same build posts nothing', async () => {
  const newer = await checkPatch(saved, 'wow_classic_beta', serve(withBuild(['us', 'eu', 'kr', 'tw'], '1.60.1.70010')));
  assert.equal(newer.kind, 'new');
  assert.equal(newer.event.current.version, '1.60.1.70010');
  assert.equal(newer.event.previous.version, '1.60.1.70009');
  const again = await checkPatch(newer.entry, 'wow_classic_beta', serve(withBuild(['us', 'eu', 'kr', 'tw'], '1.60.1.70010', { seqn: 4045500 })));
  assert.equal(again.kind, 'same');
  assert.equal(again.event, undefined);
  const repack = await checkPatch(saved, 'wow_classic_beta', serve(table.replaceAll('05215079e3905ef5922ae0b03ffefb73', 'bbbb')));
  assert.equal(repack.kind, 'repack');
  assert.equal(repack.event, undefined);
  assert.equal(repack.entry.buildConfig, 'bbbb');
});

test('regions catching up later post nothing more', async () => {
  const first = await checkPatch(saved, 'wow_classic_beta', serve(withBuild(['us'], '1.60.1.70010')));
  assert.equal(first.kind, 'new');
  const later = await checkPatch(first.entry, 'wow_classic_beta', serve(withBuild(['us', 'eu', 'kr', 'tw'], '1.60.1.70010', { seqn: 4045600 })));
  assert.equal(later.event, undefined);
  assert.deepEqual(later.entry.regions, { us: '1.60.1.70010', eu: '1.60.1.70010', kr: '1.60.1.70010', tw: '1.60.1.70010' });
});

test('a rollback is posted, but an older copy of the table is ignored', async () => {
  const newer = { ...saved, version: '1.60.1.70010', buildId: 70010, seqn: 4045400 };
  const rolledBack = await checkPatch(newer, 'wow_classic_beta', serve(withBuild([], '', { seqn: 4045500 })));
  assert.equal(rolledBack.kind, 'rollback');
  assert.equal(rolledBack.event.current.version, '1.60.1.70009');
  const stale = await checkPatch(newer, 'wow_classic_beta', serve(table));
  assert.equal(stale.kind, 'stale');
  assert.equal(stale.event, undefined);
  assert.equal(stale.entry, newer, 'the saved build is kept');
});

test('the second address is used when the first fails; both failing is an error', async () => {
  const web = serve(new Error('Patch server: HTTP 503'), table);
  const result = await checkPatch(saved, 'wow_classic_beta', web);
  assert.equal(result.kind, 'same');
  assert.match(web.asked[0], /^https:\/\/us\.version\.battle\.net\/v2\/products\/wow_classic_beta\/versions$/);
  assert.match(web.asked[1], /^http:\/\/us\.patch\.battle\.net:1119\/wow_classic_beta\/versions$/);
  await assert.rejects(checkPatch(saved, 'wow_classic_beta', serve(new Error('Patch server: HTTP 404'), 'No matched data')),
    /Patch server: no builds listed/);
  await assert.rejects(checkPatch(saved, 'wow_classic_beta', serve(new Error('Patch server: HTTP 404'), new Error('Patch server: network failure or timeout'))),
    /network failure/);
});

test('the build message', () => {
  const current = summariseRows(parseVersions(withBuild(['us', 'eu'], '1.60.1.70010')).rows);
  const embed = buildEmbed({ product: 'wow_classic_beta', previous: saved, current, kind: 'new' }, new Date('2026-09-30T00:00:00Z'));
  assert.equal(embed.title, 'New Forever build: 1.60.1.70010');
  assert.equal(embed.description, 'Was 1.60.1.70009. On US, EU. Still 1.60.1.70009: KR, TW.');
  assert.equal(embed.footer.text, 'Blizzard patch server, wow_classic_beta');
  assert.equal(embed.timestamp, '2026-09-30T00:00:00.000Z');
  const back = buildEmbed({ product: 'wow_classic_beta', previous: current, current: saved, kind: 'rollback' });
  assert.equal(back.title, 'Forever build rolled back: 1.60.1.70009');
  assert.doesNotMatch(JSON.stringify([embed, back]), /—/, 'no em dashes');
});

test('a version that is not 1.x says it may not be Forever any more', () => {
  const current = { version: '2.5.5.60000', buildId: 60000, regions: { us: '2.5.5.60000' } };
  const embed = buildEmbed({ product: 'wow_classic_beta', previous: saved, current, kind: 'rollback' });
  assert.equal(embed.title, 'wow_classic_beta build rolled back: 2.5.5.60000');
  assert.match(embed.description, /may not be WoW Forever any more/);
});
