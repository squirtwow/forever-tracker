// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiChanges, checkUiSource, summariseFiles, uiEmbed } from '../src/uisource.mjs';
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
const doc = name => `Interface/AddOns/Blizzard_APIDocumentationGenerated/${name}Documentation.lua`;
const file = (filename, status = 'modified', extra = {}) => ({ filename, status, additions: 2, deletions: 1, ...extra });
const files = [
  file('version.txt'),
  file('Interface/ui-code-list.txt'),
  file(doc('Sample'), 'modified', { patch: modifiedDoc }),
  file(doc('Flyout'), 'added', { patch: newDoc }),
  file(doc('Quiet'), 'modified', { patch: lines(['@@ -1 +1 @@', `-${T}${T}${T}Documentation = { "old" },`, `+${T}${T}${T}Documentation = { "new" },`]) }),
  file(doc('Huge'), 'modified'),
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
  assert.deepEqual(apiChanges(newDoc), { namespace: 'C_Flyout', added: ['GetFlyoutInfo'], removed: [] });
  assert.deepEqual(apiChanges(undefined), { namespace: null, added: [], removed: [] });
});

test('a summary of the changed files, leaving out version.txt and the code list', () => {
  const summary = summariseFiles(files);
  assert.equal(summary.files, 8);
  assert.equal(summary.additions, 16);
  assert.equal(summary.deletions, 8);
  assert.equal(summary.capped, false);
  assert.deepEqual(summary.addons, ['Blizzard_APIDocumentationGenerated', 'Blizzard_ActionBar', 'Blizzard_CooldownViewer', 'Blizzard_UnitFrame']);
  assert.deepEqual(summary.api.map(entry => [entry.status, entry.name]), [['added', 'Flyout'], ['modified', 'Sample']]);
  assert.equal(summary.quietDocs, 2, 'a doc with no function changes, and one GitHub sent without a patch');
  assert.deepEqual(summary.changedFiles, [
    { status: 'added', path: 'ActionBar/Shared/New.lua', from: undefined },
    { status: 'removed', path: 'ActionBar/Old.lua', from: undefined },
    { status: 'renamed', path: 'UnitFrame/Shared/Util.lua', from: 'UnitFrame/Mainline/Util.lua' },
  ]);
  assert.equal(summariseFiles(Array.from({ length: 300 }, (_, i) => file(`Interface/AddOns/Blizzard_X/${i}.lua`))).capped, true);
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
  assert.match(embed.description, /^8 files, \+16 \/ -8 lines\. \[Compare 70009\.\.\.70010\]\(https:\/\/github\.com\/Gethe\/wow-ui-source\/compare\/aaaaaaaaaaaa\.\.\.bbbbbbbbbbbb\)/);
  assert.match(embed.description, /\*\*API changes\*\*\n• New C\\_Flyout: GetFlyoutInfo\n• Sample: \+GetNewThing, \+NewName, \+SAMPLE\\_CHANGED, -OldName\n• 2 more docs changed$/);
  assert.equal(embed.fields[0].name, 'Blizzard addons changed (4)');
  assert.equal(embed.fields[0].value, '**CooldownViewer**, **UnitFrame**, APIDocumentationGenerated, ActionBar');
  assert.equal(embed.fields[1].value, '+ ActionBar/Shared/New.lua\n\\- ActionBar/Old.lua\nUnitFrame/Mainline/Util.lua → UnitFrame/Shared/Util.lua');
});

test('a huge diff stays inside Discord limits, cut at whole lines', () => {
  const many = Array.from({ length: 400 }, (_, i) => file(i % 2 ? `Interface/AddOns/Blizzard_Addon${i}/File.lua` : doc(`Doc${i}`), 'added',
    { patch: newDoc.replace('GetFlyoutInfo', `Function${i}WithAFairlyLongName`) }));
  const embed = finishEmbed(uiEmbed({
    head: { sha: 'c'.repeat(40), message: '1.61.0 (71000)' }, builds: ['1.60.1 (70010)', '1.61.0 (71000)'],
    summary: summariseFiles(many), url: 'https://github.com/x', linkText: 'Compare 70009...71000',
  }));
  assert.match(embed.description, /^300\+ files \(GitHub lists the first 300\)/);
  assert.match(embed.description, /Covers 1\.60\.1 \(70010\), 1\.61\.0 \(71000\)\./);
  assert.match(embed.description, /\n…and \d+ more$/);
  assert.ok(embed.description.length <= 4096);
  for (const field of embed.fields) assert.ok(field.value.length <= 1024);
  assert.match(embed.fields[0].value, /, \+\d+ more$/);
  const total = embed.title.length + embed.description.length + embed.footer.text.length
    + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(total <= 6000);
});

// A fake GitHub API.
function github({ list, compare = null, commit = null, status = 200 }) {
  const asked = [];
  const fetcher = async (url, init) => {
    const href = String(url);
    asked.push({ url: href, headers: init.headers });
    if (href.includes('/commits?sha=forever')) {
      if (init.headers['If-None-Match'] === '"same"') return new Response(null, { status: 304 });
      return Response.json(list, { status, headers: { ETag: '"new-etag"' } });
    }
    if (href.includes('/compare/')) return compare instanceof Response ? compare : compare ? Response.json(compare) : new Response('{}', { status: 404 });
    if (href.includes('/commits/')) return Response.json(commit);
    return new Response('{}', { status: 404 });
  };
  return { asked, fetcher, sleep: async () => {} };
}
const commitRow = (sha, message) => ({ sha, commit: { message, committer: { date: '2026-09-30T01:00:00Z' } } });
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const saved = { sha: A, message: '1.60.1 (70009)', etag: '"old"' };

test('the first time, the newest commit is only recorded', async () => {
  const web = github({ list: [commitRow(A, '1.60.1 (70009)\n\nbody')] });
  const result = await checkUiSource(null, { token: 'test-token', ...web });
  assert.equal(result.first, true);
  assert.equal(result.event, undefined);
  assert.deepEqual(result.entry, { sha: A, message: '1.60.1 (70009)', etag: '"new-etag"', date: '2026-09-30T01:00:00Z' });
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
  assert.match(web.asked[1].url, new RegExp(`/compare/${A}\\.\\.\\.${C}$`));
  assert.deepEqual(result.event.builds, ['1.60.1 (70010)', '1.60.1 (70011)']);
  assert.equal(result.event.linkText, 'Compare 70009...70011');
  assert.equal(result.event.url, `https://github.com/Gethe/wow-ui-source/compare/${A.slice(0, 12)}...${C.slice(0, 12)}`);
  assert.equal(result.event.summary.files, 8);
});

test('when the saved commit is gone from the branch, only the newest commit is shown', async () => {
  const web = github({ list: [commitRow(C, '1.60.1 (70011)')], compare: { status: 'diverged', files: [] }, commit: { sha: C, files } });
  const result = await checkUiSource(saved, web);
  assert.equal(result.event.url, `https://github.com/Gethe/wow-ui-source/commit/${C}`);
  assert.match(result.event.note, /history changed/);
  const gone = await checkUiSource(saved, github({ list: [commitRow(C, '1.60.1 (70011)')], commit: { sha: C, files } }));
  assert.equal(gone.event.linkText, `View commit ${C.slice(0, 7)}`);
});

test('GitHub failing moves nothing forward', async () => {
  await assert.rejects(checkUiSource(saved, github({ list: [], status: 500 })), /^Error: GitHub: HTTP 500$/);
  await assert.rejects(checkUiSource(saved, github({ list: { message: 'nope' } })), /GitHub: unexpected commit list/);
  const broken = github({ list: [commitRow(C, '1.60.1 (70011)'), commitRow(A, '1.60.1 (70009)')], compare: new Response('{}', { status: 502 }) });
  await assert.rejects(checkUiSource(saved, broken), /GitHub: HTTP 502/);
});
