'use strict';

// Snapshot files on disk: <userData>/snapshots/<iso-stamp>-<trigger>.json.
// Shared by the app (main.js) and scripts/snapshot-running.js.

const fs = require('fs');
const path = require('path');
const state = require('./state');
const agents = require('./agents');
const snap = require('./snapshot');

function snapshotsDir(userDataDir) {
  return path.join(userDataDir, 'snapshots');
}

function agentRegistryDir(userDataDir) {
  return path.join(userDataDir, 'agent-registry');
}

function listSnapshotNames(userDataDir) {
  try {
    return fs.readdirSync(snapshotsDir(userDataDir));
  } catch {
    return [];
  }
}

function readSnapshot(userDataDir, name) {
  if (!snap.parseSnapshotFileName(name)) return null; // also blocks path traversal
  try {
    return JSON.parse(fs.readFileSync(path.join(snapshotsDir(userDataDir), name), 'utf8'));
  } catch {
    return null;
  }
}

// Snapshot the persisted layout + the agents live in `shells` ([{ slug, pid }]).
// Never writes an empty snapshot: one taken right after launch (before
// restoring) must not shadow a good one.
function takeSnapshot(userDataDir, shells, trigger) {
  const { agents: agentsBySlug, unidentified } = agents.discoverAgents(shells, agentRegistryDir(userDataDir));
  const snapshot = snap.buildSnapshot({ state: state.loadState(userDataDir), agentsBySlug, trigger });
  const result = { saved: false, trigger, agentCount: snapshot.agentCount, unidentified: unidentified.length, name: null };
  if (snapshot.agentCount === 0) return result;

  const dir = snapshotsDir(userDataDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = snap.snapshotFileName(new Date(snapshot.takenAt), trigger);
  const file = path.join(dir, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(snapshot, null, 2), 'utf8');
  fs.renameSync(`${file}.tmp`, file);
  for (const old of snap.namesToPrune(listSnapshotNames(userDataDir))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      /* best effort */
    }
  }
  return { ...result, saved: true, name };
}

function snapshotSummaries(userDataDir) {
  return snap
    .sortSnapshotNames(listSnapshotNames(userDataDir))
    .map(({ name, trigger }) => {
      const data = readSnapshot(userDataDir, name);
      return data ? { name, trigger, takenAt: data.takenAt, agentCount: data.agentCount || 0 } : null;
    })
    .filter(Boolean);
}

function planSnapshotRestore(userDataDir, shells, name) {
  const snapshot = readSnapshot(userDataDir, name);
  if (!snapshot) return null;
  const items = snap.planRestore(snapshot, {
    liveAgentSlugs: agents.slugsRunningAgents(shells),
    exists: (p) => fs.existsSync(p),
  });
  return { name, takenAt: snapshot.takenAt, trigger: snapshot.trigger, snapshot, items };
}

module.exports = {
  snapshotsDir,
  agentRegistryDir,
  listSnapshotNames,
  readSnapshot,
  takeSnapshot,
  snapshotSummaries,
  planSnapshotRestore,
};
