'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadState, saveState, defaultState } = require('../src/state');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibedeck-state-'));
}

test('loadState should return defaults when no state file exists', () => {
  assert.deepEqual(loadState(tmpDir()), defaultState());
});

test('loadState should return defaults for a corrupt or malformed file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');
  assert.deepEqual(loadState(dir), defaultState());
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ repos: 'nope' }));
  assert.deepEqual(loadState(dir), defaultState());
});

test('saveState then loadState should round-trip and fill missing fields', () => {
  const dir = tmpDir();
  const repos = [{ id: 'r1', name: 'repo', cwd: '/tmp/repo', sessions: [{ id: 's1', name: 'one', slug: 'tg_1' }] }];
  saveState(dir, { repos, activeRepoId: 'r1' });
  const loaded = loadState(dir);
  assert.deepEqual(loaded.repos, repos);
  assert.equal(loaded.activeRepoId, 'r1');
  assert.deepEqual(loaded.activeSessionByRepo, {});
  assert.equal(loaded.sidebarWidth, 210);
  assert.deepEqual(loaded.parentFolders, []);
});

test('saveState should write atomically (no temp file left behind)', () => {
  const dir = tmpDir();
  saveState(dir, defaultState());
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});
