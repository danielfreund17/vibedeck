#!/usr/bin/env node
'use strict';

// Take a session snapshot of a *running* VibeDeck from outside the app — e.g.
// right before quitting an older build (that has no on-quit snapshot) to install
// a new one. Finds each tab's shell by its VIBEDECK_SESSION_SLUG env var.
//
//   node scripts/snapshot-running.js

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');
const store = require('../src/snapshot-store');

const USER_DATA = process.env.VIBEDECK_USER_DATA || path.join(os.homedir(), 'Library/Application Support/vibedeck');

// [{ slug, pid }] for each tab shell: a direct child of the VibeDeck (or dev
// Electron) main process carrying a slug. Processes that detached from a tab
// keep the env var but are reparented, so they're ignored.
function vibedeckShells() {
  const out = execFileSync('ps', ['eww', '-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rows = [];
  const appPids = new Set();
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    rows.push(row);
    if (/\/Contents\/MacOS\/(VibeDeck|Electron)(\s|$)/.test(row.command)) appPids.add(row.pid);
  }
  const shells = [];
  for (const row of rows) {
    const slug = row.command.match(/(?:^|\s)VIBEDECK_SESSION_SLUG=([A-Za-z0-9_-]+)/)?.[1];
    if (slug && appPids.has(row.ppid)) shells.push({ slug, pid: row.pid });
  }
  return shells;
}

const shells = vibedeckShells();
const result = store.takeSnapshot(USER_DATA, shells, 'manual');
console.log(`${shells.length} VibeDeck tab shells found`);
if (!result.saved) console.log('No identifiable pi / Claude sessions — nothing saved.');
else console.log(`Saved ${result.agentCount} agent sessions -> ${path.join(store.snapshotsDir(USER_DATA), result.name)}`);
if (result.unidentified) {
  console.log(`${result.unidentified} running agent(s) could not be identified (pi started before the registry extension: run /reload in those tabs, then re-run this).`);
}
