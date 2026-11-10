'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// renderer/work.js is an ES module (loaded by the renderer); import it dynamically.
const load = () => import('../renderer/work.js');

const PR1 = 'https://github.com/o/api/pull/1';
const PR2 = 'https://github.com/o/web/pull/2';
const PR3 = 'https://github.com/o/cli/pull/3';

function fresh(extra = {}) {
  return { tickets: [], prs: [], hiddenWork: [], ...extra };
}

test('normalizeSessionWork should keep valid refs only, deduped', async () => {
  const { normalizeSessionWork } = await load();
  const s = normalizeSessionWork({ tickets: ['jira:ABC-1', 'jira:ABC-1', 'bad', 7], prs: [PR1, 'https://x.com/pull/1'], hiddenWork: 'nope' });
  assert.deepEqual(s.tickets, ['jira:ABC-1']);
  assert.deepEqual(s.prs, [PR1]);
  assert.deepEqual(s.hiddenWork, []);
  assert.deepEqual(normalizeSessionWork({}).tickets, [], 'old sessions get empty lists');
});

test('mergeRefs should add new refs, move re-touched ones last and report changes', async () => {
  const { mergeRefs } = await load();
  const s = fresh({ tickets: ['jira:A-1', 'jira:A-2'] });
  assert.equal(mergeRefs(s, { tickets: ['jira:A-1'], prs: [PR1] }), true);
  assert.deepEqual(s.tickets, ['jira:A-2', 'jira:A-1']);
  assert.deepEqual(s.prs, [PR1]);
  assert.equal(mergeRefs(s, { tickets: ['jira:A-1'], prs: [PR1] }), false, 'same order again is a no-op');
});

test('mergeRefs should not re-add detached refs unless attached manually', async () => {
  const { mergeRefs, detachRef } = await load();
  const s = fresh({ prs: [PR1] });
  detachRef(s, PR1);
  assert.deepEqual(s.prs, []);
  assert.equal(mergeRefs(s, { prs: [PR1] }), false);
  assert.deepEqual(s.prs, []);
  assert.equal(mergeRefs(s, { prs: [PR1] }, { manual: true }), true);
  assert.deepEqual(s.prs, [PR1]);
  assert.deepEqual(s.hiddenWork, []);
});

test('prTone should rank failure over review over pending over draft', async () => {
  const { prTone } = await load();
  assert.equal(prTone(null), 'unknown');
  assert.equal(prTone({ error: 'x' }), 'error');
  assert.equal(prTone({ state: 'MERGED', checks: 'FAILURE' }), 'merged');
  assert.equal(prTone({ state: 'CLOSED' }), 'closed');
  assert.equal(prTone({ state: 'OPEN', checks: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED' }), 'failing');
  assert.equal(prTone({ state: 'OPEN', checks: 'SUCCESS', reviewDecision: 'CHANGES_REQUESTED' }), 'changes');
  assert.equal(prTone({ state: 'OPEN', checks: 'PENDING', isDraft: true }), 'pending');
  assert.equal(prTone({ state: 'OPEN', checks: 'SUCCESS', isDraft: true }), 'draft');
  assert.equal(prTone({ state: 'OPEN', checks: 'SUCCESS', reviewDecision: 'APPROVED' }), 'approved');
  assert.equal(prTone({ state: 'OPEN' }), 'open');
});

test('buildWorkItems should fold a ticket PRs under it and sort live work by urgency', async () => {
  const { buildWorkItems, chipText } = await load();
  const s = fresh({ tickets: ['t:1', 't:2'], prs: [PR1, PR3] });
  const tickets = {
    't:1': { label: 'T-1', title: 'Done thing', prs: [PR2], done: true },
    't:2': { label: 'T-2', title: 'Live thing', prs: [PR1] },
  };
  const statuses = {
    [PR1]: { state: 'OPEN', checks: 'FAILURE' },
    [PR2]: { state: 'MERGED' },
    [PR3]: { state: 'OPEN', checks: 'SUCCESS', isDraft: true },
  };
  const items = buildWorkItems(s, tickets, statuses);
  assert.deepEqual(items.map((i) => i.label), ['T-2', 'cli#3', 'T-1'], 'PR1 is shown under T-2, finished T-1 last');
  assert.equal(items[0].tone, 'failing');
  assert.equal(chipText(items[0]), 'T-2 · 1 PR · CI ✗');
  assert.equal(chipText(items[1]), 'cli#3 · draft');
  assert.equal(chipText(items[2]), 'T-1 · 1 PR · merged');
});

test('buildWorkItems should treat an unresolved ticket as neutral and use the id as label', async () => {
  const { buildWorkItems, chipText } = await load();
  const [item] = buildWorkItems(fresh({ tickets: ['jira:ABC-9'] }), {}, {});
  assert.equal(item.tone, 'ticket');
  assert.equal(chipText(item), 'ABC-9');
});

test('chipsFor should prefer live items and count the rest', async () => {
  const { chipsFor } = await load();
  const live = { tone: 'open' };
  const done = { tone: 'merged' };
  assert.deepEqual(chipsFor([live, live, live, done], 2), { shown: [live, live], more: 2 });
  assert.deepEqual(chipsFor([live, done], 2), { shown: [live], more: 1 });
  assert.deepEqual(chipsFor([done, done, done], 2), { shown: [done], more: 2 }, "only finished work: one chip");
  assert.deepEqual(chipsFor([], 2), { shown: [], more: 0 });
});

test('workListRows should list tickets with their PRs indented', async () => {
  const { buildWorkItems, workListRows } = await load();
  const items = buildWorkItems(fresh({ tickets: ['t:1'], prs: [PR3] }), { 't:1': { label: 'T-1', prs: [PR1], url: 'https://t/1' } }, {});
  const rows = workListRows(items);
  assert.deepEqual(rows.map((r) => r.value.url), ['https://t/1', PR1, PR3]);
  assert.equal(rows[1].value.ref, null, 'a ticket PR cannot be detached on its own');
  assert.equal(rows[2].value.ref, PR3);
});
