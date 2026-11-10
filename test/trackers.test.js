'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('../src/trackers');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibedeck-trackers-'));
}

test('normalizeConfig should compile valid trackers and report bad ones without throwing', () => {
  const { trackers, errors } = t.normalizeConfig(
    {
      trackers: [
        { name: 'jira', label: 'J {id}', url: 'https://x/browse/{id}', id: '^([A-Z]+-\\d+)$', detect: { command: ['jira (\\S+)', '(['] } },
        { name: 'Bad Name' },
        { name: 'jira' },
        { name: 'lin', detect: { output: [{ when: 'linear new', match: 'Created (LIN-\\d+)' }, { when: 'x' }] } },
      ],
    },
    '/cfg'
  );
  assert.deepEqual(trackers.map((x) => x.name), ['jira', 'lin']);
  assert.equal(trackers[0].command.length, 1, 'the invalid regex is dropped, the valid one kept');
  assert.equal(trackers[0].label, 'J {id}');
  assert.equal(trackers[1].label, '{id}', 'default label');
  assert.equal(trackers[1].output.length, 1);
  assert.equal(errors.length, 4);
  assert.deepEqual(t.normalizeConfig(null), { trackers: [], errors: [] });
});

test('normalizeConfig should resolve resolver and watch paths against the config dir', () => {
  const { trackers } = t.normalizeConfig({ trackers: [{ name: 'x', resolve: './r.js', watch: ['~/a.json', 'b.json'] }] }, '/cfg');
  assert.equal(trackers[0].resolve, '/cfg/r.js');
  assert.deepEqual(trackers[0].watch, [path.join(os.homedir(), 'a.json'), '/cfg/b.json']);
});

test('loadConfig should treat a missing file as no trackers and a broken one as an error', () => {
  const dir = tmpDir();
  assert.deepEqual(t.loadConfig(dir).trackers, []);
  fs.writeFileSync(path.join(dir, 'config.json'), '{ nope');
  const broken = t.loadConfig(dir);
  assert.deepEqual(broken.trackers, []);
  assert.equal(broken.errors.length, 1);
});

test('parseTicketInput should match tracker id regexes or an explicit tracker prefix', () => {
  const { trackers } = t.normalizeConfig({
    trackers: [
      { name: 'jira', id: '^([A-Z]+-\\d+)$' },
      { name: 'gh', id: '^#?(\\d+)$' },
    ],
  });
  assert.deepEqual(t.parseTicketInput(trackers, 'ABC-12'), { tracker: 'jira', id: 'ABC-12' });
  assert.deepEqual(t.parseTicketInput(trackers, '#42'), { tracker: 'gh', id: '42' });
  assert.deepEqual(t.parseTicketInput(trackers, 'gh:#43'), { tracker: 'gh', id: '43' });
  assert.equal(t.parseTicketInput(trackers, 'hello world'), null);
  assert.equal(t.parseTicketInput([], 'ABC-12'), null);
  const [alt] = t.normalizeConfig({ trackers: [{ name: 'x', id: '^#(\\d+)$|/task/(\\d+)' }] }).trackers;
  assert.deepEqual(t.parseTicketInput([alt], 'https://h/task/77'), { tracker: 'x', id: '77' }, 'first non-empty capture wins');
});

test('fillTemplate should substitute and encode the id', () => {
  assert.equal(t.fillTemplate('https://x/{id}?a={id}', 'A B'), 'https://x/A%20B?a=A%20B');
  assert.equal(t.fillTemplate(null, 'A'), null);
});

test('parseResolverOutput should keep well-formed fields only', () => {
  const out = t.parseResolverOutput(
    JSON.stringify({ tickets: { 'A-1': { title: 'T', state: 'Open', url: 'javascript:x', prs: ['u', 3], done: 'yes' }, 'A-2': null } })
  );
  assert.deepEqual(out, { 'A-1': { title: 'T', state: 'Open', url: null, prs: ['u'], done: false } });
  assert.equal(t.parseResolverOutput('not json'), null);
});

test('runResolver should run a JS resolver with tickets on stdin', async () => {
  const dir = tmpDir();
  const script = path.join(dir, 'resolve.js');
  fs.writeFileSync(
    script,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const {tickets}=JSON.parse(s);` +
      `console.log(JSON.stringify({tickets:Object.fromEntries(tickets.map(id=>[id,{title:'T '+id,prs:['https://github.com/o/r/pull/1']}]))}))})`
  );
  const [tracker] = t.normalizeConfig({ trackers: [{ name: 'x', resolve: './resolve.js' }] }, dir).trackers;
  const out = await t.runResolver(tracker, ['A-1']);
  assert.equal(out['A-1'].title, 'T A-1');
  assert.deepEqual(out['A-1'].prs, ['https://github.com/o/r/pull/1']);
});

test('runResolver should reject when the resolver fails or prints garbage', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'fail.js'), 'console.error("boom"); process.exit(2)');
  fs.writeFileSync(path.join(dir, 'junk.js'), 'console.log("hi")');
  const { trackers } = t.normalizeConfig(
    { trackers: [{ name: 'a', resolve: 'fail.js' }, { name: 'b', resolve: 'junk.js' }] },
    dir
  );
  await assert.rejects(t.runResolver(trackers[0], ['1']), /a resolver failed: boom/);
  await assert.rejects(t.runResolver(trackers[1], ['1']), /invalid JSON/);
});
