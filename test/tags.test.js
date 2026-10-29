'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// renderer/tags.js is an ES module (loaded by the renderer); import it dynamically.
const load = () => import('../renderer/tags.js');

test('normalizeTagLibrary should seed the default status tags on first run', async () => {
  const { normalizeTagLibrary, DEFAULT_TAGS } = await load();
  const lib = normalizeTagLibrary(undefined);
  assert.deepEqual(lib.map((t) => t.name), [
    'exploration',
    'in progress',
    'needs review',
    'needs QA',
    'needs monitoring',
    'done monitoring',
    'blocked',
    'done',
  ]);
  lib[0].name = 'mutated';
  assert.equal(DEFAULT_TAGS[0].name, 'exploration', 'defaults must not be shared by reference');
});

test('normalizeTagLibrary should keep an existing list as-is (deleted defaults stay deleted) and clean it', async () => {
  const { normalizeTagLibrary } = await load();
  const lib = normalizeTagLibrary([
    { name: '  needs   QA ', color: '#ffb547' },
    { name: 'NEEDS qa', color: '#000000' },
    { name: '', color: '#123456' },
    { name: 'custom', color: 'red' },
  ]);
  assert.deepEqual(lib.map((t) => t.name), ['needs QA', 'custom']);
  assert.match(lib[1].color, /^#[0-9a-f]{6}$/i, 'invalid color replaced by a generated one');
});

test('ensureTag should add new tags once, matching case-insensitively', async () => {
  const { ensureTag, colorForTag } = await load();
  const lib = [{ name: 'needs QA', color: '#ffb547' }];
  assert.equal(ensureTag(lib, 'needs qa').name, 'needs QA');
  const created = ensureTag(lib, '  waiting  on  infra ');
  assert.deepEqual(created, { name: 'waiting on infra', color: colorForTag('waiting on infra') });
  assert.equal(lib.length, 2);
  assert.equal(ensureTag(lib, '   '), null);
  assert.equal(ensureTag(lib, 'x'.repeat(100)).name.length, 32);
});

test('colorForTag should be stable', async () => {
  const { colorForTag } = await load();
  assert.equal(colorForTag('Foo'), colorForTag('foo'));
  assert.match(colorForTag('anything'), /^#[0-9a-f]{6}$/i);
});

test('withTag / withoutTag should not duplicate and should match case-insensitively', async () => {
  const { withTag, withoutTag } = await load();
  assert.deepEqual(withTag(['done'], 'DONE'), ['done']);
  assert.deepEqual(withTag(undefined, 'done'), ['done']);
  assert.deepEqual(withoutTag(['done', 'blocked'], 'Done'), ['blocked']);
});

test('normalizeSessionTags should canonicalize names and re-add unknown tags to the list', async () => {
  const { normalizeSessionTags } = await load();
  const lib = [{ name: 'needs QA', color: '#ffb547' }];
  assert.deepEqual(normalizeSessionTags(['needs qa', 'NEEDS QA', 'legacy', 42, ''], lib), ['needs QA', 'legacy', '42']);
  assert.deepEqual(lib.map((t) => t.name), ['needs QA', 'legacy', '42']);
  assert.deepEqual(normalizeSessionTags('nope', lib), []);
});

test('sortByLibrary should order tab tags by list position', async () => {
  const { sortByLibrary, normalizeTagLibrary } = await load();
  const lib = normalizeTagLibrary(undefined);
  assert.deepEqual(sortByLibrary(['done', 'custom', 'blocked', 'exploration'], lib), ['exploration', 'blocked', 'done', 'custom']);
});

test('tagPickerRows should exclude current tags, rank prefix matches, and offer create', async () => {
  const { tagPickerRows, normalizeTagLibrary } = await load();
  const lib = normalizeTagLibrary(undefined);
  const names = (rows) => rows.map((r) => `${r.kind}:${r.name}`);
  assert.equal(tagPickerRows(lib, '', ['done']).some((r) => r.name === 'done'), false);
  assert.deepEqual(names(tagPickerRows(lib, 'mon', [])), ['existing:needs monitoring', 'existing:done monitoring', 'create:mon']);
  assert.deepEqual(names(tagPickerRows(lib, 'done', [])), ['existing:done', 'existing:done monitoring'], 'exact match first');
  assert.deepEqual(names(tagPickerRows(lib, 'review', [])), ['existing:needs review', 'create:review'], 'substring match');
  assert.deepEqual(names(tagPickerRows(lib, 'Needs QA', [])), ['existing:needs QA'], 'no create row for an existing tag');
  assert.deepEqual(names(tagPickerRows(lib, 'needs qa', ['needs QA'])), [], 'already on the tab: nothing to add or create');
});

test('tagUsageCount should count tabs across scopes', async () => {
  const { tagUsageCount } = await load();
  const repos = [{ sessions: [{ tags: ['done'] }, { tags: [] }] }, { sessions: [{ tags: ['DONE', 'blocked'] }, {}] }];
  assert.equal(tagUsageCount(repos, 'done'), 2);
  assert.equal(tagUsageCount(repos, 'blocked'), 1);
});
