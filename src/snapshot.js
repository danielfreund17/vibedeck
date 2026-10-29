'use strict';

// Session snapshots: a point-in-time record of which coding agent (pi / Claude
// Code) is running in which VibeDeck tab, so a later "restore" can re-launch
// every agent on the same conversation after a quit or reboot.
//
// Everything here is pure (no fs / process access) so it can be unit-tested;
// src/agents.js gathers the live inputs and main.js does the I/O.

const path = require('path');

const AGENT_KINDS = new Set(['pi', 'claude']);
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)-([a-z]+)\.json$/;
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_FLAG_VALUE_RE = /^[A-Za-z0-9._:/@=+-]{1,128}$/;

// Flags that are safe and meaningful to carry over when resuming a session.
// Anything else (prompts, -p/--print, --resume/--continue, --api-key, …) is
// dropped. `true` = boolean flag, `false` = takes one value.
const CARRY_FLAGS = {
  claude: {
    '--dangerously-skip-permissions': true,
    '--permission-mode': false,
    '--model': false,
    '--agent': false,
  },
  pi: {
    '--provider': false,
    '--model': false,
    '--thinking': false,
  },
};

// `ps -A -o pid=,ppid=,comm=` -> [{ pid, ppid, comm }]
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] });
  }
  return rows;
}

// "pi", "/Users/x/.local/bin/claude", "-zsh" -> "pi" / "claude" / null
function agentKindForComm(comm) {
  const base = path.basename(String(comm || '').trim());
  return AGENT_KINDS.has(base) ? base : null;
}

// Breadth-first search below a session's shell for the shallowest agent
// process. Shallowest wins so an agent launched *by* another agent (e.g. `pi`
// run from Claude's bash tool) is not mistaken for the tab's agent.
function findAgentProcess(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  let frontier = children.get(rootPid) || [];
  const seen = new Set([rootPid]);
  while (frontier.length) {
    const found = frontier.find((row) => agentKindForComm(row.comm));
    if (found) return { pid: found.pid, kind: agentKindForComm(found.comm) };
    const next = [];
    for (const row of frontier) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      next.push(...(children.get(row.pid) || []));
    }
    frontier = next;
  }
  return null;
}

// Split a `ps -o args=` command line. Good enough for agent flags (no quoting
// of flag values is expected); prompts with spaces are dropped anyway.
function splitArgs(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

// Keep only allow-listed flags (with validated values) from an agent's argv.
function carryFlags(kind, argv) {
  const allowed = CARRY_FLAGS[kind] || {};
  const out = [];
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (!(name in allowed)) continue;
    if (allowed[name] === true) {
      if (eq < 0 && !out.includes(name)) out.push(name);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : args[i + 1];
    if (eq < 0) i++;
    if (value != null && SAFE_FLAG_VALUE_RE.test(String(value)) && !String(value).startsWith('-')) {
      out.push(name, String(value));
    }
  }
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

// The shell command that re-opens an agent session, e.g.
//   builtin cd -- '/repo' && pi --session 01a1…
// Throws on anything that isn't safe to type into a shell.
function buildResumeCommand(agent) {
  if (!agent || !AGENT_KINDS.has(agent.kind)) throw new Error('unknown agent kind');
  if (!isSafeId(agent.sessionId)) throw new Error('invalid session id');
  if (!agent.cwd || !path.isAbsolute(agent.cwd)) throw new Error('invalid cwd');
  const flags = (agent.flags || []).filter((f) => SAFE_FLAG_VALUE_RE.test(f));
  const resume = agent.kind === 'pi' ? ['--session', agent.sessionId] : ['--resume', agent.sessionId];
  return `builtin cd -- ${shellQuote(agent.cwd)} && ${[agent.kind, ...flags, ...resume].join(' ')}`;
}

// Combine the persisted layout with the live agents (keyed by session slug).
function buildSnapshot({ state, agentsBySlug, trigger, now = new Date() }) {
  const agents = agentsBySlug || {};
  let agentCount = 0;
  const repos = (state?.repos || []).map((repo) => ({
    id: repo.id,
    name: repo.name,
    cwd: repo.cwd,
    sessions: (repo.sessions || []).map((session) => {
      const agent = agents[session.slug] || null;
      if (agent) agentCount++;
      return {
        id: session.id,
        slug: session.slug,
        name: session.name,
        nameSource: session.nameSource,
        tags: Array.isArray(session.tags) ? session.tags : [],
        cwd: session.cwd || repo.cwd,
        agent: agent
          ? {
              kind: agent.kind,
              sessionId: agent.sessionId,
              sessionFile: agent.sessionFile || null,
              cwd: agent.cwd,
              flags: agent.flags || [],
            }
          : null,
      };
    }),
  }));
  return { version: SNAPSHOT_VERSION, takenAt: now.toISOString(), trigger, agentCount, repos };
}

function snapshotFileName(date, trigger) {
  const stamp = date.toISOString().replace(/:/g, '-').replace('.', '-');
  return `${stamp}-${trigger}.json`;
}

function parseSnapshotFileName(name) {
  const match = String(name).match(SNAPSHOT_FILE_RE);
  return match ? { name, stamp: match[1], trigger: match[2] } : null;
}

// "2026-10-26T14-03-00-123Z" -> Date
function stampToDate(stamp) {
  const iso = String(stamp).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/, (_m, h, mi, s, ms) => `${h}:${mi}:${s}.${ms || '000'}Z`);
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

// True if a daily snapshot already exists for `now`'s local calendar day.
function hasDailyFor(names, now = new Date()) {
  const today = localDateKey(now);
  return sortSnapshotNames(names).some((e) => e.trigger === 'daily' && stampToDate(e.stamp) && localDateKey(stampToDate(e.stamp)) === today);
}

// Newest first. ISO-ish stamps sort lexically.
function sortSnapshotNames(names) {
  return names
    .map(parseSnapshotFileName)
    .filter(Boolean)
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Retention: keep the newest `keepDaily` daily snapshots and the newest
// `keepOther` of every other trigger. Returns the names to delete.
function namesToPrune(names, { keepDaily = 14, keepOther = 10 } = {}) {
  const kept = new Map();
  const remove = [];
  for (const entry of sortSnapshotNames(names)) {
    const limit = entry.trigger === 'daily' ? keepDaily : keepOther;
    const count = kept.get(entry.trigger) || 0;
    if (count < limit) kept.set(entry.trigger, count + 1);
    else remove.push(entry.name);
  }
  return remove;
}

// Decide, per snapshotted tab, whether it can be resumed now.
//   liveAgentSlugs: slugs whose tab already runs an agent (skip — never double-launch)
//   exists(p):      filesystem probe
function planRestore(snapshot, { liveAgentSlugs = new Set(), exists = () => true } = {}) {
  const items = [];
  for (const repo of snapshot?.repos || []) {
    for (const session of repo.sessions || []) {
      if (!session.agent) continue;
      const base = { repoId: repo.id, sessionId: session.id, slug: session.slug, name: session.name, kind: session.agent.kind };
      if (liveAgentSlugs.has(session.slug)) {
        items.push({ ...base, action: 'skip', reason: 'already running' });
        continue;
      }
      if (!exists(session.agent.cwd)) {
        items.push({ ...base, action: 'skip', reason: `directory missing: ${session.agent.cwd}` });
        continue;
      }
      if (session.agent.sessionFile && !exists(session.agent.sessionFile)) {
        items.push({ ...base, action: 'skip', reason: 'session file missing' });
        continue;
      }
      try {
        items.push({ ...base, action: 'resume', command: buildResumeCommand(session.agent) });
      } catch (error) {
        items.push({ ...base, action: 'skip', reason: error.message });
      }
    }
  }
  return items;
}

module.exports = {
  SNAPSHOT_VERSION,
  parseProcessTable,
  agentKindForComm,
  findAgentProcess,
  splitArgs,
  carryFlags,
  shellQuote,
  isSafeId,
  buildResumeCommand,
  buildSnapshot,
  snapshotFileName,
  parseSnapshotFileName,
  sortSnapshotNames,
  localDateKey,
  stampToDate,
  hasDailyFor,
  namesToPrune,
  planRestore,
};
