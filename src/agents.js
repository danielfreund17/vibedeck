'use strict';

// Live agent discovery: for each VibeDeck tab (identified by its shell pid),
// find the pi / Claude Code process running in it and the conversation it has
// open. Synchronous on purpose — it must also work inside `before-quit`.
//
//   Claude Code writes ~/.claude/sessions/<pid>.json ({ sessionId, cwd, kind }).
//   pi has no such file, so the VibeDeck pi extension writes
//   <userData>/agent-registry/pi-<pid>.json ({ sessionId, sessionFile, cwd, argv }).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const snap = require('./snapshot');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function processTable() {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return snap.parseProcessTable(out);
  } catch {
    return [];
  }
}

function processArgs(pid) {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

// Claude stores a transcript under the project it was started in, which can
// differ from the process's current cwd (e.g. after `cd` into a worktree), and
// `claude --resume <id>` only finds it from that project. So locate the
// transcript and resume from the cwd it recorded.
function claudeTranscript(sessionId) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let cwd = null;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      cwd = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1] || null;
      if (cwd) cwd = JSON.parse(`"${cwd}"`);
    } catch {
      cwd = null;
    }
    return { file, cwd };
  }
  return null;
}

function claudeAgent(pid) {
  const info = readJson(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`));
  if (!info || info.kind !== 'interactive' || !snap.isSafeId(info.sessionId) || !info.cwd) return null;
  const argv = snap.splitArgs(processArgs(pid)).slice(1);
  const transcript = claudeTranscript(info.sessionId);
  return {
    kind: 'claude',
    pid,
    sessionId: info.sessionId,
    cwd: transcript?.cwd || info.cwd,
    sessionFile: transcript?.file || null,
    flags: snap.carryFlags('claude', argv),
  };
}

function piAgent(pid, registryDir) {
  const info = readJson(path.join(registryDir, `pi-${pid}.json`));
  if (!info || !snap.isSafeId(info.sessionId) || !info.cwd) return null;
  return {
    kind: 'pi',
    pid,
    sessionId: info.sessionId,
    cwd: info.cwd,
    sessionFile: info.sessionFile || null,
    flags: snap.carryFlags('pi', Array.isArray(info.argv) ? info.argv : []),
  };
}

// Drop registry files left behind by pi processes that have exited.
function pruneRegistry(registryDir, livePids) {
  let names;
  try {
    names = fs.readdirSync(registryDir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = name.match(/^pi-(\d+)\.json$/);
    if (match && !livePids.has(Number(match[1]))) {
      try {
        fs.unlinkSync(path.join(registryDir, name));
      } catch {
        /* best effort */
      }
    }
  }
}

// shells: [{ slug, pid }] -> { agents: { [slug]: agent }, unidentified: [{ slug, kind, pid }] }
// `unidentified` = an agent is running but its conversation id is unknown (e.g. a
// pi started before the registry-writing extension was loaded).
function discoverAgents(shells, registryDir) {
  const rows = processTable();
  const agents = {};
  const unidentified = [];
  for (const { slug, pid } of shells) {
    const proc = snap.findAgentProcess(rows, pid);
    if (!proc) continue;
    const agent = proc.kind === 'claude' ? claudeAgent(proc.pid) : piAgent(proc.pid, registryDir);
    if (agent) agents[slug] = agent;
    else unidentified.push({ slug, kind: proc.kind, pid: proc.pid });
  }
  pruneRegistry(registryDir, new Set(rows.map((r) => r.pid)));
  return { agents, unidentified };
}

// Slugs whose tab currently runs any agent process (identified or not).
function slugsRunningAgents(shells) {
  const rows = processTable();
  return new Set(shells.filter(({ pid }) => snap.findAgentProcess(rows, pid)).map(({ slug }) => slug));
}

module.exports = { discoverAgents, slugsRunningAgents };
