'use strict';

// Integration test for the main-process work tracker: a real config folder, a
// real resolver script, and a stub `gh` on PATH (no network, no timers —
// start() is never called).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkTracker } = require('../src/work-tracker');

const PR1 = 'https://github.com/acme/api/pull/1';
const PR2 = 'https://github.com/acme/web/pull/2';

function setup({ withGh = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-work-'));
  const configDir = path.join(root, 'local');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(configDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      trackers: [
        {
          name: 'acme',
          label: '{id}',
          url: 'https://tracker.example/{id}',
          id: '^(ACME-\\d+)$',
          resolve: './resolve.js',
        },
      ],
    })
  );
  // Resolver: knows ACME-1 (with a PR opened elsewhere), not ACME-2.
  fs.writeFileSync(
    path.join(configDir, 'resolve.js'),
    `let s = ''; process.stdin.on('data', (c) => (s += c)).on('end', () => {
      const { tickets } = JSON.parse(s);
      const out = {};
      if (tickets.includes('ACME-1')) out['ACME-1'] = { title: 'Fix login', state: 'In Review', prs: [${JSON.stringify(PR2)}] };
      process.stdout.write(JSON.stringify({ tickets: out }));
    });`
  );
  if (withGh) {
    // Stub gh: answers every aliased PR in the GraphQL query; web#2 has failing CI.
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(
      ghPath,
      `#!${process.execPath}
      const q = process.argv.find((a) => a.startsWith('query=')) || '';
      const data = {};
      for (const [, alias, url] of q.matchAll(/(p\\d+): resource\\(url: "([^"]+)"\\)/g)) {
        const number = Number(url.split('/').pop());
        data[alias] = { number, title: 'PR ' + number, state: 'OPEN', merged: false, isDraft: false,
          repository: { nameWithOwner: url.split('/').slice(3, 5).join('/') },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: number === 2 ? 'FAILURE' : 'SUCCESS' } } }] } };
      }
      process.stdout.write(JSON.stringify({ data }));`
    );
    fs.chmodSync(ghPath, 0o755);
  }
  const sent = [];
  const tracker = createWorkTracker({
    configDir,
    registryDir: path.join(root, 'registry'),
    liveShells: () => [],
    send: (channel, payload) => sent.push([channel, payload]),
    env: { PATH: bin, HOME: root },
    log: { warn() {}, error() {}, log() {}, info() {} },
  });
  return { tracker, sent, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));

test('work tracker should resolve tickets and fetch PR status for synced tabs', async () => {
  const { tracker, cleanup } = setup();
  try {
    await tracker.refresh(); // loads config
    assert.equal(tracker.describe().trackers[0].name, 'acme');
    assert.deepEqual(tracker.parseRef('ACME-7'), { kind: 'ticket', key: 'acme:ACME-7' });
    assert.deepEqual(tracker.parseRef(`${PR1}/files`), { kind: 'pr', url: PR1 });

    tracker.sync([{ slug: 'tab-1', tickets: ['acme:ACME-1', 'acme:ACME-2'], prs: [PR1] }]);
    await settle();
    const snap = tracker.snapshot();

    assert.equal(snap.tickets['acme:ACME-1'].title, 'Fix login');
    assert.equal(snap.tickets['acme:ACME-1'].url, 'https://tracker.example/ACME-1', 'url falls back to the template');
    assert.deepEqual(snap.tickets['acme:ACME-1'].prs, [PR2]);
    assert.equal(snap.tickets['acme:ACME-2'].title, null, 'unknown ticket keeps base info');
    assert.equal(snap.statuses[PR1].checks, 'SUCCESS');
    assert.equal(snap.statuses[PR2].checks, 'FAILURE', "PRs pulled in by a ticket's resolver are fetched too");
    assert.equal(snap.error, null);
  } finally {
    tracker.stop();
    cleanup();
  }
});

test('work tracker should report a missing gh CLI instead of failing silently', async () => {
  const { tracker, sent, cleanup } = setup({ withGh: false });
  try {
    await tracker.refresh();
    tracker.sync([{ slug: 'tab-1', tickets: [], prs: [PR1] }]);
    await settle();
    const prs = sent.filter(([channel]) => channel === 'work:prs').pop()[1];
    assert.equal(prs.error, 'GitHub CLI (gh) not found');
    assert.equal(prs.statuses[PR1].error, 'GitHub CLI (gh) not found');
  } finally {
    tracker.stop();
    cleanup();
  }
});
