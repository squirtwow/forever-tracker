// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiChanges, checkUiSource, docTags, summariseFiles, uiEmbed } from '../src/uisource.mjs';
import { finishEmbed } from '../src/discord.mjs';

const T = '\t';
const lines = rows => rows.join('\n');
// A modified documentation file: one function added, one renamed in place (its
// Type line unchanged), one event added, one function moved, one table added.
const modifiedDoc = lines([
  '@@ -10,6 +10,15 @@ local Sample =',
  ` ${T}${T}{`,
  `+${T}${T}${T}Name = "GetNewThing",`,
  `+${T}${T}${T}Type = "Function",`,
  `+${T}${T}},`,
  `+${T}${T}{`,
  `-${T}${T}${T}Name = "OldName",`,
  `+${T}${T}${T}Name = "NewName",`,
  ` ${T}${T}${T}Type = "Function",`,
  ` ${T}${T}},`,
  `-${T}${T}{`,
  `-${T}${T}${T}Name = "MovedThing",`,
  `-${T}${T}${T}Type = "Function",`,
  `-${T}${T}},`,
  '@@ -80,6 +89,20 @@ local Sample =',
  `+${T}${T}{`,
  `+${T}${T}${T}Name = "MovedThing",`,
  `+${T}${T}${T}Type = "Function",`,
  `+${T}${T}${T}Arguments =`,
  `+${T}${T}${T}{`,
  `+${T}${T}${T}${T}{ Name = "thingID", Type = "number", Nilable = false },`,
  `+${T}${T}${T}},`,
  `+${T}${T}},`,
  `+${T}${T}{`,
  `+${T}${T}${T}Name = "SampleChanged",`,
  `+${T}${T}${T}Type = "Event",`,
  `+${T}${T}${T}LiteralName = "SAMPLE_CHANGED",`,
  `+${T}${T}},`,
  `+${T}${T}{`,
  `+${T}${T}${T}Name = "SampleInfo",`,
  `+${T}${T}${T}Type = "Structure",`,
  `+${T}${T}},`,
]);
const newDoc = lines([
  '@@ -0,0 +1,20 @@',
  '+local Flyout =',
  '+{',
  `+${T}Name = "Flyout",`,
  `+${T}Type = "System",`,
  `+${T}Namespace = "C_Flyout",`,
  `+${T}Functions =`,
  `+${T}{`,
  `+${T}${T}{`,
  `+${T}${T}${T}Name = "GetFlyoutInfo",`,
  `+${T}${T}${T}Type = "Function",`,
  `+${T}${T}},`,
  `+${T}},`,
]);
// Real kinds of change seen in the 1.60.1 (70009) diff.
const enumDoc = lines([
  '@@ -20,8 +20,9 @@',
  `-${T}${T}${T}NumValues = 2,`,
  `+${T}${T}${T}NumValues = 3,`,
  `+${T}${T}${T}${T}{ Name = "SelectHighestLevelLinkedSpell", Type = "CooldownSetSpellFlags", EnumValue = 4 },`,
]);
const secretDoc = lines(['@@ -5,7 +5,6 @@', `-${T}${T}${T}SecretInChatMessagingLockdown = true,`]);
const addFunction = name => lines(['@@ -1,3 +1,7 @@', `+${T}${T}{`, `+${T}${T}${T}Name = "${name}",`, `+${T}${T}${T}Type = "Function",`, `+${T}${T}},`]);
const doc = name => `Interface/AddOns/Blizzard_APIDocumentationGenerated/${name}Documentation.lua`;
const file = (filename, status = 'modified', extra = {}) => ({ filename, status, additions: 2, deletions: 1, ...extra });
const files = [
  file('version.txt'),
  file('Interface/ui-code-list.txt'),
  file(doc('Sample'), 'modified', { patch: modifiedDoc }),
  file(doc('Flyout'), 'added', { patch: newDoc }),
  file(doc('Quiet'), 'modified', { patch: lines(['@@ -1 +1 @@', `-${T}${T}${T}Documentation = { "old" },`, `+${T}${T}${T}Documentation = { "new" },`]) }),
  file(doc('Huge'), 'modified'),
  file(doc('CooldownViewerConstants'), 'modified', { patch: enumDoc }),
  file(doc('ChatInfo'), 'modified', { patch: secretDoc }),
  file('Interface/AddOns/Blizzard_CooldownViewer/CooldownViewer.lua'),
  file('Interface/AddOns/Blizzard_ActionBar/Shared/New.lua', 'added'),
  file('Interface/AddOns/Blizzard_ActionBar/Old.lua', 'removed'),
  file('Interface/AddOns/Blizzard_UnitFrame/Shared/Util.lua', 'renamed', { previous_filename: 'Interface/AddOns/Blizzard_UnitFrame/Mainline/Util.lua' }),
];

test('functions and events added or removed in an API documentation diff', () => {
  const changes = apiChanges(modifiedDoc);
  assert.deepEqual(changes.added, ['GetNewThing', 'NewName', 'SAMPLE_CHANGED']);
  assert.deepEqual(changes.removed, ['OldName']);
  assert.equal(changes.namespace, null);
  assert.deepEqual(changes.tags, ['types'], 'MovedThing gained an argument');
  assert.deepEqual(apiChanges(newDoc), { namespace: 'C_Flyout', added: ['GetFlyoutInfo'], removed: [], tags: [] });
  assert.deepEqual(apiChanges(undefined), { namespace: null, added: [], removed: [], tags: [] });
});

test('what else changed in a doc: secret flags, enums and types', () => {
  assert.deepEqual(docTags(enumDoc), ['enum']);
  assert.deepEqual(docTags(secretDoc), ['secret']);
  assert.deepEqual(docTags(lines([
    `-${T}${T}${T}SecretArguments = "AllowedWhenUntainted",`,
    `+${T}${T}${T}SecretArguments = "AllowedWhenTainted",`,
    `-${T}${T}${T}${T}{ Name = "byteOffsets", Type = "table", InnerType = "number", Nilable = false },`,
    `+${T}${T}${T}${T}{ Name = "byteOffsets", Type = "table", InnerType = "luaIndex", Nilable = false },`,
  ])), ['secret', 'types']);
  assert.deepEqual(docTags(`+${T}${T}${T}ChecksForbiddenAspects = true,`), ['secret']);
  assert.deepEqual(docTags(lines([' SecretArguments = "x",', `-${T}${T}${T}Documentation = { "old" },`])), [], 'unchanged lines and wording only');
  const newFunction = lines([
    '@@ -1,3 +1,12 @@', `+${T}${T}{`, `+${T}${T}${T}Name = "UnitThing",`, `+${T}${T}${T}Type = "Function",`,
    `+${T}${T}${T}SecretArguments = "AllowedWhenUntainted",`, `+${T}${T}${T}Arguments =`, `+${T}${T}${T}{`,
    `+${T}${T}${T}${T}{ Name = "unit", Type = "UnitToken", Nilable = false },`, `+${T}${T}${T}},`, `+${T}${T}},`,
  ]);
  assert.deepEqual(apiChanges(newFunction).added, ['UnitThing']);
  assert.deepEqual(docTags(newFunction), [], "a new function's own lines don't count");
  assert.deepEqual(docTags(`${newFunction}\n+${T}${T}${T}SecretWhenUnitIdentityRestricted = true,`), ['secret'], 'a secret flag outside it does');
});

test('a summary of the changed files, leaving out version.txt and the code list', () => {
  const summary = summariseFiles(files);
  assert.equal(summary.files, 10);
  assert.equal(summary.additions, 20);
  assert.equal(summary.deletions, 10);
  assert.equal(summary.capped, false);
  assert.deepEqual(summary.addons, ['Blizzard_APIDocumentationGenerated', 'Blizzard_ActionBar', 'Blizzard_CooldownViewer', 'Blizzard_UnitFrame']);
  assert.deepEqual(summary.api.map(entry => [entry.status, entry.name, entry.global]), [['added', 'Flyout', false], ['modified', 'Sample', false]]);
  assert.deepEqual(summary.quiet, [
    { name: 'Quiet', tags: [] }, { name: 'Huge', tags: [] }, { name: 'CooldownViewerConstants', tags: ['enum'] }, { name: 'ChatInfo', tags: ['secret'] },
  ], 'docs with no function changes, one of them sent without a patch');
  assert.deepEqual(summary.changedFiles, [
    { status: 'added', path: 'ActionBar/Shared/New.lua', from: undefined },
    { status: 'removed', path: 'ActionBar/Old.lua', from: undefined },
    { status: 'renamed', path: 'UnitFrame/Shared/Util.lua', from: 'UnitFrame/Mainline/Util.lua' },
  ]);
  assert.equal(summariseFiles(Array.from({ length: 300 }, (_, i) => file(`Interface/AddOns/Blizzard_X/${i}.lua`))).capped, true);
  assert.equal(summariseFiles([file(doc('NameUtil'), 'added', { patch: addFunction('ReplaceSurname') })]).api[0].global, true, 'a new doc with no namespace');
});

test('the UI source message', () => {
  const event = {
    head: { sha: 'b'.repeat(40), message: '1.60.1 (70010)', date: '2026-09-30T01:00:00Z' },
    builds: ['1.60.1 (70010)'], summary: summariseFiles(files),
    url: 'https://github.com/Gethe/wow-ui-source/compare/aaaaaaaaaaaa...bbbbbbbbbbbb', linkText: 'Compare 70009...70010',
  };
  const embed = finishEmbed(uiEmbed(event, { watch: ['UnitFrame', 'Blizzard_CooldownViewer'] }));
  assert.equal(embed.title, 'UI source for 1.60.1 (70010)');
  assert.equal(embed.url, event.url);
  assert.equal(embed.timestamp, '2026-09-30T01:00:00Z');
  assert.equal(embed.footer.text, 'Gethe/wow-ui-source, forever branch');
  assert.match(embed.description, /^10 files, \+20 \/ -10 lines\. \[Compare 70009\.\.\.70010\]\(https:\/\/github\.com\/Gethe\/wow-ui-source\/compare\/aaaaaaaaaaaa\.\.\.bbbbbbbbbbbb\)/);
  assert.ok(embed.description.endsWith([
    '**API changes**',
    '• New C\\_Flyout: GetFlyoutInfo',
    '• Sample: +GetNewThing, +NewName, +SAMPLE\\_CHANGED, -OldName (also types)',
    '• Also changed: **CooldownViewerConstants** (enum), ChatInfo (secret), Quiet, Huge',
  ].join('\n')), embed.description);
  assert.equal(embed.fields[0].name, 'Blizzard addons changed (4)');
  assert.equal(embed.fields[0].value, '**CooldownViewer**, **UnitFrame**, APIDocumentationGenerated, ActionBar');
  assert.equal(embed.fields[1].name, 'Files added or removed');
  assert.equal(embed.fields[1].value, '+ ActionBar/Shared/New.lua\n\\- ActionBar/Old.lua\nUnitFrame/Mainline/Util.lua → UnitFrame/Shared/Util.lua');
});

test('a huge diff stays inside Discord limits, cut at whole lines, and says its counts are partial', () => {
  const many = Array.from({ length: 300 }, (_, i) => file(i % 2 ? `Interface/AddOns/Blizzard_Addon${i}/File.lua` : doc(`Doc${i}`), 'added',
    { patch: newDoc.replace('GetFlyoutInfo', `Function${i}WithAFairlyLongName`) }));
  const embed = finishEmbed(uiEmbed({
    head: { sha: 'c'.repeat(40), message: '1.61.0 (71000)' }, builds: ['1.60.1 (70010)', '1.61.0 (71000)'],
    summary: summariseFiles(many), url: 'https://github.com/x', linkText: 'Compare 70009...71000',
  }));
  assert.match(embed.description, /^300\+ files, \+600 \/ -300 lines in the first 300 \(GitHub lists no more, so all counts here are partial\)\./);
  assert.match(embed.description, /Covers 1\.60\.1 \(70010\), 1\.61\.0 \(71000\)\./);
  assert.match(embed.description, /\n…and \d+ more$/);
  assert.ok(embed.description.length <= 4096);
  for (const field of embed.fields) assert.ok(field.value.length <= 1024);
  assert.equal(embed.fields[0].name, 'Blizzard addons changed (151+)');
  assert.match(embed.fields[0].value, /, \+\d+ more$/);
  const total = embed.title.length + embed.description.length + embed.footer.text.length
    + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(total <= 6000);
});

// A fake GitHub: the commit list, a comparison, a commit (in pages of 300
// files) and raw files. `raw` maps a path to its text, or to a status.
function github({ list, compare = null, commit = null, pages = null, raw = {}, status = 200 }) {
  const asked = [];
  const fetcher = async (url, init) => {
    const href = String(url);
    asked.push({ url: href, headers: init.headers });
    let match;
    if ((match = href.match(/^https:\/\/raw\.githubusercontent\.com\/Gethe\/wow-ui-source\/[0-9a-f]{40}\/(.+)$/))) {
      const answer = raw[decodeURIComponent(match[1])];
      return typeof answer === 'string' ? new Response(answer) : new Response('', { status: answer || 404 });
    }
    if (href.includes('/commits?sha=forever')) {
      if (init.headers['If-None-Match'] === '"same"') return new Response(null, { status: 304 });
      return Response.json(list, { status, headers: { ETag: '"new-etag"' } });
    }
    if (href.includes('/compare/')) return compare instanceof Response ? compare : compare ? Response.json(compare) : new Response('{}', { status: 404 });
    if ((match = href.match(/\/commits\/[0-9a-f]{40}\?per_page=300&page=(\d+)$/))) {
      return Response.json(pages ? { files: pages[Number(match[1]) - 1] || [] } : commit);
    }
    return new Response('{}', { status: 404 });
  };
  return { asked, fetcher, sleep: async () => {} };
}
const commitRow = (sha, message) => ({ sha, commit: { message, committer: { date: '2026-09-30T01:00:00Z' } } });
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const saved = { sha: A, message: '1.60.1 (70009)', etag: '"old"' };

test('the first time, the newest commit is only recorded', async () => {
  const web = github({ list: [commitRow(A, '1.60.1 (70009)\n\nbody')] });
  const result = await checkUiSource(null, { token: 'test-token', ...web });
  assert.equal(result.first, true);
  assert.equal(result.event, undefined);
  assert.deepEqual(result.entry, { sha: A, message: '1.60.1 (70009)', etag: '"new-etag"', date: '2026-09-30T01:00:00Z', top: 70009 });
  assert.equal(web.asked[0].headers.Authorization, 'Bearer test-token');
  assert.equal(web.asked[0].headers['If-None-Match'], undefined);
});

test('an unchanged branch: a 304 or the same commit', async () => {
  const web = github({ list: [] });
  const result = await checkUiSource({ ...saved, etag: '"same"' }, web);
  assert.equal(result.kind, 'same');
  assert.equal(web.asked.length, 1);
  const same = await checkUiSource(saved, github({ list: [commitRow(A, '1.60.1 (70009)')] }));
  assert.equal(same.kind, 'same');
  assert.equal(same.entry.etag, '"new-etag"');
});

test('a new commit is compared with the saved one', async () => {
  const compare = { status: 'ahead', commits: [commitRow(B, '1.60.1 (70010)'), commitRow(C, '1.60.1 (70011)')], files };
  const web = github({ list: [commitRow(C, '1.60.1 (70011)'), commitRow(B, '1.60.1 (70010)'), commitRow(A, '1.60.1 (70009)')], compare });
  const result = await checkUiSource(saved, web);
  assert.equal(result.kind, 'new');
  assert.equal(result.entry.sha, C);
  assert.equal(result.entry.top, 70011);
  assert.match(web.asked[1].url, new RegExp(`/compare/${A}\\.\\.\\.${C}$`));
  assert.deepEqual(result.event.builds, ['1.60.1 (70010)', '1.60.1 (70011)']);
  assert.equal(result.event.linkText, 'Compare 70009...70011');
  assert.equal(result.event.url, `https://github.com/Gethe/wow-ui-source/compare/${A.slice(0, 12)}...${C.slice(0, 12)}`);
  assert.equal(result.event.summary.files, 10);
});

test('the mirror going back to an older build is not posted, and the next new build is compared with the newest posted one', async () => {
  // As on Sept 16: 69893, then 69876 again, then 69893 again.
  const posted = { sha: A, message: '1.60.1 (69893)', etag: '"old"', top: 69893 };
  const back = await checkUiSource(posted, github({ list: [commitRow(B, '1.60.1 (69876)'), commitRow(A, '1.60.1 (69893)')] }));
  assert.equal(back.kind, 'older');
  assert.equal(back.event, undefined);
  assert.equal(back.head.message, '1.60.1 (69876)');
  assert.deepEqual(back.entry, { ...posted, etag: '"new-etag"' }, 'still on the posted commit; only the ETag moves');
  const again = await checkUiSource(back.entry, github({ list: [commitRow(C, '1.60.1 (69893)'), commitRow(B, '1.60.1 (69876)')] }));
  assert.equal(again.kind, 'older', 'the same build again');
  assert.equal(again.entry.sha, A);
  const compare = { status: 'ahead', commits: [commitRow(B, '1.60.1 (69876)'), commitRow(C, '1.60.1 (69893)'), commitRow(D, '1.60.1 (70010)')], files };
  const web = github({ list: [commitRow(D, '1.60.1 (70010)'), commitRow(C, '1.60.1 (69893)')], compare });
  const next = await checkUiSource(again.entry, web);
  assert.equal(next.kind, 'new');
  assert.match(web.asked[1].url, new RegExp(`/compare/${A}\\.\\.\\.${D}$`));
  assert.deepEqual(next.event.builds, ['1.60.1 (70010)'], 'the back and forth is left out');
  assert.equal(next.event.linkText, 'Compare 69893...70010');
  assert.equal(next.entry.top, 70010);
});

test('a single new commit with 300+ files gets every file from the commit itself', async () => {
  const addonFile = i => file(`Interface/AddOns/Blizzard_A${String(i).padStart(3, '0')}/x.lua`);
  const all = Array.from({ length: 350 }, (_, i) => addonFile(i));
  const list = [commitRow(B, '1.61.0 (71000)'), commitRow(A, '1.60.1 (70009)')];
  const web = github({ list, compare: { status: 'ahead', commits: [commitRow(B, '1.61.0 (71000)')], files: all.slice(0, 300) }, pages: [all.slice(0, 300), all.slice(300)] });
  const result = await checkUiSource(saved, web);
  assert.equal(result.event.summary.files, 350);
  assert.equal(result.event.summary.capped, false);
  assert.ok(result.event.summary.addons.includes('Blizzard_A349'), 'addons late in the alphabet are there');
  assert.deepEqual(web.asked.slice(2).map(ask => ask.url.split('?')[1]), ['per_page=300&page=1', 'per_page=300&page=2']);
  // Two new commits at once can't be listed in full, so the counts say so.
  const two = github({ list, compare: { status: 'ahead', commits: [commitRow(C, '1.60.2 (70500)'), commitRow(B, '1.61.0 (71000)')], files: all.slice(0, 300) } });
  const partial = await checkUiSource(saved, two);
  assert.equal(partial.event.summary.capped, true);
  assert.equal(uiEmbed(partial.event).fields[0].name, 'Blizzard addons changed (300+)');
});

test('changed docs are named by their namespace, read from the doc itself', async () => {
  const compare = { status: 'ahead', commits: [commitRow(B, '1.60.1 (70010)')], files: [
    file(doc('UnitAura'), 'modified', { patch: addFunction('GetRefreshCarryOverDuration') }),
    file(doc('Unit'), 'modified', { patch: `${addFunction('UnitIsForeverThing')}\n+${T}${T}${T}SecretWhenUnitIdentityRestricted = true,` }),
    file(doc('PvpInfo'), 'modified', { patch: addFunction('GetArenaOpponentSpec') }),
  ] };
  const web = github({
    list: [commitRow(B, '1.60.1 (70010)'), commitRow(A, '1.60.1 (70009)')], compare,
    raw: {
      [doc('UnitAura')]: `local UnitAura =\n{\n${T}Name = "UnitAuras",\n${T}Type = "System",\n${T}Namespace = "C_UnitAuras",\n}`,
      [doc('Unit')]: `local Unit =\n{\n${T}Name = "Unit",\n${T}Type = "System",\n}`,
      [doc('PvpInfo')]: 500,
    },
  });
  const result = await checkUiSource(saved, web);
  assert.ok(web.asked.some(ask => ask.url === `https://raw.githubusercontent.com/Gethe/wow-ui-source/${B}/${doc('UnitAura')}`), 'read at the new commit');
  const embed = uiEmbed(result.event, { watch: ['UnitFrame'] });
  assert.ok(embed.description.endsWith([
    '**API changes**',
    '• C\\_UnitAuras: +GetRefreshCarryOverDuration',
    '• Unit (global): +UnitIsForeverThing (also secret)',
    '• PvpInfo: +GetArenaOpponentSpec',
  ].join('\n')), embed.description);
});

test('when the saved commit is gone from the branch, only the newest commit is shown', async () => {
  const web = github({ list: [commitRow(C, '1.60.1 (70011)')], compare: { status: 'diverged', files: [] }, commit: { sha: C, files } });
  const result = await checkUiSource(saved, web);
  assert.equal(result.event.url, `https://github.com/Gethe/wow-ui-source/commit/${C}`);
  assert.match(result.event.note, /history changed/);
  assert.equal(result.event.summary.files, 10);
  const gone = await checkUiSource(saved, github({ list: [commitRow(C, '1.60.1 (70011)')], commit: { sha: C, files } }));
  assert.equal(gone.event.linkText, `View commit ${C.slice(0, 7)}`);
});

test('GitHub failing moves nothing forward', async () => {
  await assert.rejects(checkUiSource(saved, github({ list: [], status: 500 })), /^Error: GitHub: HTTP 500$/);
  await assert.rejects(checkUiSource(saved, github({ list: { message: 'nope' } })), /GitHub: unexpected commit list/);
  const broken = github({ list: [commitRow(C, '1.60.1 (70011)'), commitRow(A, '1.60.1 (70009)')], compare: new Response('{}', { status: 502 }) });
  await assert.rejects(checkUiSource(saved, broken), /GitHub: HTTP 502/);
});
