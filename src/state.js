'use strict';

// Persistent app state: the scope -> session model. tmux only ever sees opaque
// slugs; the human-facing organization lives here, in Electron's userData dir.

const fs = require('fs');
const path = require('path');

function stateFile(userDataDir) {
  return path.join(userDataDir, 'state.json');
}

function defaultState() {
  return {
    repos: [],
    activeRepoId: null,
    activeSessionByRepo: {},
    sidebarWidth: 210,
    parentFolders: [],
  };
}

function loadState(userDataDir) {
  try {
    const raw = fs.readFileSync(stateFile(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.repos)) return defaultState();
    return {
      repos: parsed.repos,
      activeRepoId: parsed.activeRepoId ?? null,
      activeSessionByRepo: parsed.activeSessionByRepo ?? {},
      sidebarWidth: parsed.sidebarWidth ?? 210,
      parentFolders: Array.isArray(parsed.parentFolders) ? parsed.parentFolders : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(userDataDir, state) {
  const file = stateFile(userDataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic replace, avoids half-written state
}

module.exports = { loadState, saveState, defaultState };
