'use strict';

/* globals Terminal, FitAddon, WebLinksAddon */

import {
  ensureTag,
  hasTag,
  normalizeSessionTags,
  normalizeTagLibrary,
  sortByLibrary,
  tagColor,
  tagKey,
  tagPickerRows,
  tagUsageCount,
  withTag,
  withoutTag,
} from './tags.js';

// VibeDeck renderer. Owns the scope -> session model, renders the two-axis UI,
// and lazily attaches an xterm <-> pty <-> shell pipe per session on demand.

const api = window.api;

let state = {
  repos: [],
  activeRepoId: null,
  activeSessionByRepo: {},
  sidebarWidth: 210,
  parentFolders: [],
  tags: [],
};
let tagFilter = null; // show only tabs carrying this tag (not persisted)
let liveSlugs = new Set(); // sessions with a shell open right now (none, at launch)
const busySessionIds = new Set(); // sessions that emitted output recently
const busyTimers = new Map(); // sessionId -> timer that settles the activity dot
const sessionContexts = new Map(); // sessionId -> { cwd, git, pr }
const contextTimers = new Map(); // sessionId -> debounced context refresh timer
const contextRequests = new Map(); // sessionId -> monotonically increasing request id
let hostname = ''; // used to ignore a bare-hostname terminal title
let homedir = ''; // used to prettify paths (~/...)
let paletteEl = null; // the open command-palette overlay, if any

// sessionId -> { term, fit, ptyId, el }
const terminals = new Map();
// sessionId -> in-flight ensureTerminal() promise (never spawn two shells for one tab)
const terminalStarts = new Map();
// sessionId -> shell command to run once that tab's shell first starts (snapshot restore)
const pendingInitialCommands = new Map();
// ptyId -> sessionId, to route incoming pty data to the right terminal
const ptyToSession = new Map();

const el = {
  topbar: document.getElementById('topbar'),
  sidebar: document.getElementById('sidebar'),
  terminals: document.getElementById('terminals'),
  empty: document.getElementById('empty'),
  resizer: document.getElementById('resizer'),
  statusbar: document.getElementById('session-statusbar'),
};

// ---------- helpers ----------
function uid() {
  return crypto.randomUUID();
}
function newSlug() {
  return 'tg_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
function persist() {
  return api.saveState(state);
}

// Debounced save for high-frequency updates (auto-title changes).
let persistTimer = null;
function persistSoon() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    api.saveState(state);
  }, 400);
}

// Auto-naming: manual names always win. Agent-like titles (for example from a
// pi/Claude integration) outrank generic terminal titles.
function decodeTitleMetadata(encoded) {
  if (!encoded) return null;
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch {
    return null;
  }
}

function parseAutoTitle(raw) {
  let t = (raw || '').trim();
  if (!t) return null;

  let metadata = null;
  const metaMatch = t.match(/\s*⟦vd:([A-Za-z0-9_-]+)⟧\s*$/);
  if (metaMatch) {
    metadata = decodeTitleMetadata(metaMatch[1]);
    t = t.slice(0, metaMatch.index).trim();
  }

  if (hostname && t === hostname) return null; // bare hostname, not a real title
  if (/^-?(zsh|bash|sh|fish|dash|tcsh|ksh)$/i.test(t)) return null; // idle shell
  if (/^[^\s@]+@[^\s:]+:/.test(t)) return null; // user@host:path idle title

  const agentMatch = t.match(/^(pi|claude)(?:\s*[·•-]\s*|\s+)(.+)$/i);
  const source = metadata || agentMatch ? 'agent' : 'terminal';
  const name = (metadata?.title || (agentMatch ? agentMatch[2] : t)).trim();
  if (!name) return null;
  return { name: name.length > 120 ? name.slice(0, 119) + '…' : name, source, metadata };
}

function isManualName(session) {
  return session.nameSource === 'manual' || session.pinned === true;
}

function applyAutoTitle(session, rawTitle) {
  const parsed = parseAutoTitle(rawTitle);
  if (!parsed) return;

  const found = findSession(session.id);
  if (parsed.metadata?.cwd && found && !session.worktreeLocked && session.cwdSource !== 'manual') {
    session.cwd = parsed.metadata.cwd;
    session.cwdSource = 'agent';
    scheduleContextRefresh(found.repo, session, 0);
    persistSoon();
  }

  if (isManualName(session)) return;
  if (session.nameSource === 'agent' && parsed.source !== 'agent') return;
  if (parsed.name === session.name && parsed.source === session.nameSource) return;

  session.name = parsed.name;
  session.nameSource = parsed.source;
  const label = document.querySelector(`.session-name[data-sid="${session.id}"]`);
  if (label) {
    label.textContent = parsed.name;
    label.title = sessionTitle(session);
  }
  persistSoon();
}
function activeRepo() {
  return state.repos.find((r) => r.id === state.activeRepoId) || null;
}
function activeSessionId(repoId) {
  return state.activeSessionByRepo[repoId] || null;
}
function activeEntry() {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  return sid ? terminals.get(sid) : null;
}

function normalizeStateShape() {
  state.tags = normalizeTagLibrary(state.tags);
  for (const repo of state.repos || []) {
    if (!Array.isArray(repo.sessions)) repo.sessions = [];
    for (const session of repo.sessions) {
      if (!session.cwd) session.cwd = repo.cwd;
      if (!session.cwdSource) session.cwdSource = session.cwd === repo.cwd ? 'default' : 'observed';
      if (session.worktreeLocked !== true) session.worktreeLocked = session.cwdSource === 'manual';
      if (!session.nameSource) session.nameSource = session.pinned ? 'manual' : 'default';
      session.pinned = session.nameSource === 'manual'; // keep old state readers compatible
      session.tags = normalizeSessionTags(session.tags, state.tags);
    }
  }
}

function sessionTitle(session) {
  if (isManualName(session)) return `${session.name} (manual name)`;
  if (session.nameSource === 'agent') return `${session.name} (agent-named — double-click to rename)`;
  return `${session.name} (auto-named — double-click to rename)`;
}

function findSession(sessionId) {
  for (const repo of state.repos || []) {
    const session = repo.sessions.find((s) => s.id === sessionId);
    if (session) return { repo, session };
  }
  return null;
}

function findSessionBySlug(slug) {
  for (const repo of state.repos || []) {
    const session = repo.sessions.find((s) => s.slug === slug);
    if (session) return { repo, session };
  }
  return null;
}

function activeSessionRecord() {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  const session = sid ? repo.sessions.find((s) => s.id === sid) : null;
  return repo && session ? { repo, session } : null;
}

function applyExternalContextUpdate(update) {
  const found = update?.slug ? findSessionBySlug(update.slug) : activeSessionRecord();
  if (!found || !update.cwd) return;
  if (found.session.worktreeLocked && update.source !== 'vibedeck-ui') return;
  found.session.cwd = update.cwd;
  found.session.cwdSource = 'manual';
  if (update.title && !isManualName(found.session)) {
    found.session.name = update.title;
    found.session.nameSource = 'manual';
    found.session.pinned = true;
  }
  persistSoon();
  scheduleContextRefresh(found.repo, found.session, 0);
  render();
}

// A tiny text-input modal (Electron doesn't implement window.prompt).
function promptModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <input class="modal-input" type="text" spellcheck="false" />
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn btn-primary" data-act="ok">OK</button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    const input = overlay.querySelector('.modal-input');
    input.value = defaultValue;

    const close = (val) => {
      overlay.remove();
      resolve(val);
    };
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelector('[data-act=cancel]').onclick = () => close(null);
    overlay.querySelector('[data-act=ok]').onclick = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    });

    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Yes/no modal with a short multi-line body.
function confirmModal(title, bodyLines, okLabel = 'OK', cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title"></div>
        <div class="modal-body"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel"></button>
          <button class="btn btn-primary" data-act="ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = title;
    overlay.querySelector('.modal-body').innerHTML = bodyLines.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
    const ok = overlay.querySelector('[data-act=ok]');
    const cancel = overlay.querySelector('[data-act=cancel]');
    ok.textContent = okLabel;
    cancel.textContent = cancelLabel;

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    function onKey(e) {
      e.stopPropagation(); // keep keys away from the terminal behind the modal
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    }
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(false);
    });
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

// Pick one row from a list (arrows + enter, or click). Resolves the row's value or null.
function listPickerModal(placeholder, rows) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay palette-overlay';
    overlay.innerHTML = `<div class="palette"><input class="palette-input" type="text" readonly /><div class="palette-list"></div></div>`;
    const input = overlay.querySelector('.palette-input');
    const listEl = overlay.querySelector('.palette-list');
    input.placeholder = placeholder;
    let sel = 0;

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    const highlight = () => [...listEl.children].forEach((c, i) => c.classList.toggle('active', i === sel));
    rows.forEach((row, i) => {
      const item = document.createElement('div');
      item.className = 'palette-item' + (i === 0 ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'pi-name';
      label.textContent = row.label;
      const detail = document.createElement('span');
      detail.className = 'pi-path';
      detail.textContent = row.detail || '';
      item.append(label, detail);
      item.onmouseenter = () => {
        sel = i;
        highlight();
      };
      item.onclick = () => close(row.value);
      listEl.appendChild(item);
    });
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'Nothing here yet.';
      listEl.appendChild(empty);
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'ArrowDown' && rows.length) {
        e.preventDefault();
        sel = (sel + 1) % rows.length;
        highlight();
      } else if (e.key === 'ArrowUp' && rows.length) {
        e.preventDefault();
        sel = (sel - 1 + rows.length) % rows.length;
        highlight();
      } else if (e.key === 'Enter' && rows[sel]) {
        e.preventDefault();
        close(rows[sel].value);
      }
    }
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    input.focus();
  });
}

// Transient bottom-right notice.
function toast(text, ms = 4000) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = text;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

// ---------- snapshots ----------
// A snapshot records which pi / Claude conversation runs in which tab (taken
// daily, on quit, and on demand by the main process). Restoring re-opens each
// tab's shell and types `cd <dir> && pi --session <id>` / `claude --resume <id>`.

const RESTORE_STAGGER_MS = 800; // don't boot two dozen Node agents at once

function formatSnapshotTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function saveSnapshotNow() {
  const result = await api.saveSnapshot();
  if (result?.error) toast(`Snapshot failed: ${result.error}`, 6000);
  else if (!result?.saved) toast('Nothing to snapshot — no running pi / Claude sessions found.');
  else {
    const missed = result.unidentified
      ? ` · ${pluralize(result.unidentified, 'agent')} not captured (run /reload in older pi sessions)`
      : '';
    toast(`Snapshot saved: ${pluralize(result.agentCount, 'agent session')}${missed}`, missed ? 7000 : 4000);
  }
}

function restoreSummaryLines(plan) {
  const resume = plan.items.filter((i) => i.action === 'resume');
  const skipped = plan.items.filter((i) => i.action === 'skip');
  const byKind = (kind) => resume.filter((i) => i.kind === kind).length;
  const lines = [
    `Snapshot: ${formatSnapshotTime(plan.takenAt)} (${plan.trigger})`,
    `Resume ${pluralize(resume.length, 'session')}: ${byKind('pi')} pi · ${byKind('claude')} Claude`,
  ];
  if (skipped.length) {
    lines.push(`Skip ${skipped.length}:`);
    for (const item of skipped.slice(0, 8)) lines.push(`  • ${item.name} — ${item.reason}`);
    if (skipped.length > 8) lines.push(`  • …and ${skipped.length - 8} more`);
  }
  return lines;
}

// Make sure every tab being resumed exists (re-creating closed tabs/scopes from
// the snapshot) and queue its resume command. Returns [{ repo, session, command }].
function mergeSnapshotLayout(plan) {
  const commands = new Map(plan.items.filter((i) => i.action === 'resume').map((i) => [i.sessionId, i.command]));
  const targets = [];
  for (const snapRepo of plan.snapshot.repos || []) {
    const snapSessions = (snapRepo.sessions || []).filter((s) => commands.has(s.id));
    if (!snapSessions.length) continue;
    let repo = state.repos.find((r) => r.id === snapRepo.id) || state.repos.find((r) => r.cwd === snapRepo.cwd);
    if (!repo) {
      repo = { id: snapRepo.id, name: snapRepo.name, cwd: snapRepo.cwd, sessions: [] };
      state.repos.push(repo);
    }
    for (const snapSession of snapSessions) {
      let found = findSession(snapSession.id);
      if (!found) {
        const slugTaken = Boolean(findSessionBySlug(snapSession.slug));
        const session = {
          id: snapSession.id,
          name: snapSession.name,
          nameSource: snapSession.nameSource || 'default',
          cwd: snapSession.cwd || repo.cwd,
          cwdSource: (snapSession.cwd || repo.cwd) === repo.cwd ? 'default' : 'agent',
          worktreeLocked: false,
          slug: slugTaken ? newSlug() : snapSession.slug,
          pinned: snapSession.nameSource === 'manual',
          tags: normalizeSessionTags(snapSession.tags, state.tags),
        };
        repo.sessions.push(session);
        found = { repo, session };
      }
      targets.push({ ...found, command: commands.get(snapSession.id) });
    }
  }
  return targets;
}

async function restoreSnapshot(name, { confirmFirst = true, launchOffer = false } = {}) {
  const plan = await api.planSnapshotRestore(name);
  if (!plan) {
    toast('Snapshot could not be read.');
    return;
  }
  const resumeCount = plan.items.filter((i) => i.action === 'resume').length;
  if (!resumeCount) {
    if (!launchOffer) toast('Nothing to restore — every agent in that snapshot is already running or unavailable.', 6000);
    return;
  }
  if (confirmFirst) {
    const title = launchOffer
      ? `Restore ${pluralize(resumeCount, 'agent session')} from your last snapshot?`
      : `Restore ${pluralize(resumeCount, 'agent session')}?`;
    const ok = await confirmModal(title, restoreSummaryLines(plan), 'Restore', launchOffer ? 'Not now' : 'Cancel');
    if (!ok) return;
  }

  const targets = mergeSnapshotLayout(plan);
  normalizeStateShape();
  if (!state.activeRepoId && state.repos.length) state.activeRepoId = state.repos[0].id;
  for (const repo of state.repos) {
    if (!state.activeSessionByRepo[repo.id] && repo.sessions.length) state.activeSessionByRepo[repo.id] = repo.sessions[0].id;
  }
  // Queue first: if the user opens a tab before the stagger reaches it, its
  // shell starts with the command anyway (ensureTerminal consumes the queue).
  const live = [];
  for (const target of targets) {
    if (terminals.has(target.session.id)) live.push(target);
    else pendingInitialCommands.set(target.session.id, target.command);
  }
  await persist();
  render(); // mounts (and so resumes) the active tab first

  // Tabs whose shell is already open (and idle — no agent, per the plan): type it in.
  for (const target of live) {
    const entry = terminals.get(target.session.id);
    if (entry) api.writeSession(entry.ptyId, `${target.command}\r`);
  }
  let started = live.length;
  for (const target of targets) {
    if (!pendingInitialCommands.has(target.session.id)) continue; // already started
    await ensureTerminal(target.repo, target.session, { background: true });
    started++;
    await new Promise((r) => setTimeout(r, RESTORE_STAGGER_MS));
  }
  mountActive();
  toast(`Restored ${pluralize(started, 'agent session')}.`);
}

async function restoreLatestSnapshot(options = {}) {
  const snapshots = await api.listSnapshots();
  const latest = snapshots.find((s) => s.agentCount > 0);
  if (!latest) {
    if (!options.launchOffer) toast('No snapshots yet — use "Save Session Snapshot" or wait for the daily one.', 6000);
    return;
  }
  await restoreSnapshot(latest.name, options);
}

async function pickAndRestoreSnapshot() {
  const snapshots = await api.listSnapshots();
  const name = await listPickerModal(
    'Pick a snapshot to restore  (⏎ restore · esc close)',
    snapshots.map((s) => ({
      value: s.name,
      label: formatSnapshotTime(s.takenAt),
      detail: `${s.trigger} · ${pluralize(s.agentCount, 'agent')}`,
    }))
  );
  if (name) await restoreSnapshot(name);
}

// ---------- mutations ----------
// Open a repo folder as a scope tab; focus it if it's already open.
async function openRepoScope(cwd, name) {
  const existing = state.repos.find((r) => r.cwd === cwd);
  if (existing) {
    await selectRepo(existing.id);
    return;
  }
  const repo = { id: uid(), name, cwd, sessions: [] };
  state.repos.push(repo);
  state.activeRepoId = repo.id;
  await persist();
  render();
}

function prettyPath(p) {
  return homedir && p && p.startsWith(homedir) ? '~' + p.slice(homedir.length) : p;
}

function shortenMiddle(text, max = 36) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

function prLabel(pr) {
  if (!pr || pr.lookupState === 'none') return 'no PR';
  if (pr.lookupState === 'error') return 'PR unavailable';
  if (pr.lookupState !== 'found') return 'checking PR…';
  const state = pr.isDraft ? 'draft' : String(pr.state || '').toLowerCase();
  return `#${pr.number} ${state}`;
}

function prClass(pr) {
  if (!pr || pr.lookupState !== 'found') return pr?.lookupState === 'error' ? 'pr-error' : 'pr-none';
  if (pr.isDraft) return 'pr-draft';
  return `pr-${String(pr.state || 'open').toLowerCase()}`;
}

function gitLabel(ctx) {
  if (!ctx) return 'checking context…';
  if (ctx.git?.unknownWorktree) return 'worktree unknown';
  if (!ctx.git?.isRepo) return 'no git repo';
  const branch = ctx.git.branch || (ctx.git.shortSha ? `detached ${ctx.git.shortSha}` : 'detached');
  const dirty = ctx.git.dirty ? ' dirty' : '';
  const ahead = ctx.git.ahead ? ` ↑${ctx.git.ahead}` : '';
  const behind = ctx.git.behind ? ` ↓${ctx.git.behind}` : '';
  return `${shortenMiddle(branch)}${dirty}${ahead}${behind}`;
}

function contextTooltip(session, ctx) {
  const lines = [sessionTitle(session), `cwd: ${session.cwd || ''}`];
  if (ctx?.git?.isRepo) {
    lines.push(`worktree: ${ctx.git.worktreeRoot}`);
    lines.push(`branch: ${ctx.git.branch || `detached ${ctx.git.shortSha || ''}`}`);
    if (ctx.pr?.lookupState === 'found') lines.push(`PR #${ctx.pr.number}: ${ctx.pr.title}`);
    else lines.push(`PR: ${prLabel(ctx.pr)}`);
  } else if (ctx) {
    lines.push('not a git repository');
  }
  return lines.filter(Boolean).join('\n');
}

function updateSessionContext(sessionId, ctx) {
  // Window focus re-resolves every tab; most come back unchanged. Skipping those
  // avoids rebuilding the sidebar under the user's cursor for nothing.
  const unchanged = JSON.stringify(sessionContexts.get(sessionId)) === JSON.stringify(ctx);
  sessionContexts.set(sessionId, ctx);
  if (unchanged) return;
  renderSidebar();
  renderStatusbar();
}

function scheduleContextRefresh(repo, session, delay = 250) {
  if (!repo || !session) return;
  const key = session.id;
  const existing = contextTimers.get(key);
  if (existing) clearTimeout(existing);
  contextTimers.set(
    key,
    setTimeout(async () => {
      contextTimers.delete(key);
      const requestId = (contextRequests.get(key) || 0) + 1;
      contextRequests.set(key, requestId);
      const cwd = session.cwd || repo.cwd;
      try {
        const ctx = await api.resolveSessionContext({
          cwd,
          repoCwd: repo.cwd,
          cwdSource: session.cwdSource || 'default',
          sessionName: session.name,
        });
        if (contextRequests.get(key) !== requestId) return;
        if (ctx.cwdSource === 'inferred' && session.cwdSource === 'default' && ctx.cwd && ctx.cwd !== session.cwd) {
          session.cwd = ctx.cwd;
          session.cwdSource = 'inferred';
          persistSoon();
        }
        updateSessionContext(key, ctx);
      } catch {
        if (contextRequests.get(key) !== requestId) return;
        updateSessionContext(key, { cwd, git: { isRepo: false }, pr: { lookupState: 'error', message: 'Context lookup failed' } });
      }
    }, delay)
  );
}

function refreshAllSessionContexts(delay = 100) {
  for (const repo of state.repos || []) {
    for (const session of repo.sessions || []) scheduleContextRefresh(repo, session, delay);
  }
}

// Fuzzy score: prefix > substring > subsequence; -Infinity means no match.
function fuzzyScore(name, q) {
  if (!q) return 0;
  const idx = name.indexOf(q);
  if (idx === 0) return 1000 - name.length;
  if (idx > 0) return 600 - idx;
  let qi = 0;
  for (let i = 0; i < name.length && qi < q.length; i++) {
    if (name[i] === q[qi]) qi++;
  }
  return qi === q.length ? 200 - name.length : -Infinity;
}

// A direct hit in a command's label (prefix or substring) outranks keyword
// matches; otherwise a keyword prefix on a short keyword list would beat the
// command you actually named (typing "tag" listed Delete Tag above Add Tag).
function scoreCommand(command, q) {
  const label = fuzzyScore(command.label.toLowerCase(), q);
  if (label >= 400) return label + 1000;
  return Math.max(label, fuzzyScore(command.keywords, q) - 100);
}

// Command palette (⌘P / the + button): search git repos under registered
// parent folders and open one as a scope tab.
let paletteRepos = [];
async function openPalette() {
  if (paletteEl) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay palette-overlay';
  overlay.innerHTML = `
    <div class="palette">
      <input class="palette-input" type="text" placeholder="Search repos…  (⏎ open · esc close)" spellcheck="false" />
      <div class="palette-list"></div>
      <div class="palette-actions">
        <button class="palette-action" data-act="add-parent">+ Add parent folder…</button>
        <button class="palette-action" data-act="open-folder">📁 Open other folder…</button>
      </div>
      <div class="palette-sources"></div>
    </div>`;
  paletteEl = overlay;

  const input = overlay.querySelector('.palette-input');
  const listEl = overlay.querySelector('.palette-list');
  const sourcesEl = overlay.querySelector('.palette-sources');
  const openCwds = new Set(state.repos.map((r) => r.cwd));

  let items = [];
  let sel = 0;

  function computeItems() {
    const q = input.value.trim().toLowerCase();
    const repoItems = !q
      ? paletteRepos.map((repo) => ({ type: 'repo', repo }))
      : paletteRepos
          .map((repo) => ({ type: 'repo', repo, score: fuzzyScore(repo.name.toLowerCase(), q) }))
          .filter((item) => item.score > -Infinity)
          .sort((a, b) => b.score - a.score);
    const commandMatches = !q
      ? []
      : commandItems()
          .filter((command) => command.enabled)
          .map((command) => ({
            type: 'command',
            command,
            score: scoreCommand(command, q),
          }))
          .filter((item) => item.score > -Infinity)
          .sort((a, b) => b.score - a.score);
    items = [...commandMatches, ...repoItems];
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
  }

  function highlight() {
    [...listEl.children].forEach((c, i) => c.classList.toggle('active', i === sel));
    listEl.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!paletteRepos.length) {
      const d = document.createElement('div');
      d.className = 'palette-empty';
      d.textContent = 'No repos yet. Add a parent folder (like ~/git-repos) below.';
      listEl.appendChild(d);
      return;
    }
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'palette-empty';
      d.textContent = 'No match.';
      listEl.appendChild(d);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'palette-item' + (i === sel ? ' active' : '');
      const nm = document.createElement('span');
      nm.className = 'pi-name';
      const pa = document.createElement('span');
      pa.className = 'pi-path';
      if (item.type === 'command') {
        nm.textContent = item.command.label;
        pa.textContent = item.command.detail;
      } else {
        nm.textContent = item.repo.name;
        pa.textContent = openCwds.has(item.repo.path) ? '• already open' : prettyPath(item.repo.parent);
      }
      row.append(nm, pa);
      row.onmouseenter = () => {
        sel = i;
        highlight();
      };
      row.onclick = () => choose(item);
      listEl.appendChild(row);
    });
  }

  function renderSources() {
    sourcesEl.innerHTML = '';
    (state.parentFolders || []).forEach((p) => {
      const chip = document.createElement('span');
      chip.className = 'source-chip';
      const label = document.createElement('span');
      label.textContent = prettyPath(p);
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove source';
      x.onclick = (e) => {
        e.stopPropagation();
        removeParent(p);
      };
      chip.append(label, x);
      sourcesEl.appendChild(chip);
    });
  }

  async function rescan() {
    paletteRepos = await api.scanRepos(state.parentFolders || []);
    computeItems();
    renderList();
    renderSources();
  }

  async function choose(item) {
    close();
    if (item.type === 'command') await item.command.run();
    else await openRepoScope(item.repo.path, item.repo.name);
  }

  function close() {
    overlay.remove();
    paletteEl = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) {
        sel = (sel + 1) % items.length;
        highlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) {
        sel = (sel - 1 + items.length) % items.length;
        highlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[sel]) choose(items[sel]);
    }
  }

  async function removeParent(p) {
    state.parentFolders = (state.parentFolders || []).filter((x) => x !== p);
    await persist();
    await rescan();
    input.focus();
  }

  input.addEventListener('input', () => {
    computeItems();
    renderList();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('[data-act=add-parent]').onclick = async () => {
    const picked = await api.pickFolder();
    if (!picked) return;
    if (!Array.isArray(state.parentFolders)) state.parentFolders = [];
    if (!state.parentFolders.includes(picked.path)) state.parentFolders.push(picked.path);
    await persist();
    await rescan();
    input.focus();
  };

  overlay.querySelector('[data-act=open-folder]').onclick = async () => {
    const picked = await api.pickFolder();
    if (!picked) return;
    close();
    await openRepoScope(picked.path, picked.name);
  };

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  input.focus();
  await rescan();
}

function contextTitle(ctx) {
  if (ctx?.pr?.lookupState === 'found' && ctx.pr.title) return shortenMiddle(ctx.pr.title, 48);
  if (ctx?.git?.branch) return shortenMiddle(ctx.git.branch, 48);
  return 'worktree';
}

function commandItems() {
  return [
    {
      label: 'Rename Current Tab…',
      detail: 'Rename the selected vertical tab',
      keywords: 'rename tab session name title current active',
      enabled: Boolean(activeSessionRecord()),
      run: () => renameActiveSession(),
    },
    {
      label: 'Add Tag…',
      detail: 'Tag the selected tab (needs QA, blocked, …) or create a new tag',
      keywords: 'tag label status add needs review qa monitoring blocked done exploration progress',
      enabled: Boolean(activeSessionRecord()),
      run: () => addTagToActiveSession(),
    },
    {
      label: 'Remove Tag…',
      detail: 'Remove a tag from the selected tab',
      keywords: 'tag label status remove untag clear',
      enabled: Boolean(activeSessionRecord()?.session.tags?.length),
      run: () => removeTagFromActiveSession(),
    },
    {
      label: tagFilter ? `Filter Tabs by Tag… (now: ${tagFilter})` : 'Filter Tabs by Tag…',
      detail: 'Show only tabs with a given tag in the sidebar',
      keywords: 'tag filter show only find status',
      enabled: state.tags.length > 0,
      run: () => pickTagFilter(),
    },
    {
      label: 'Delete Tag from List…',
      detail: 'Remove a tag from the tag list (and from every tab that has it)',
      keywords: 'tag delete list manage remove',
      enabled: state.tags.length > 0,
      run: () => deleteTagFromList(),
    },
    {
      label: 'Save Session Snapshot',
      detail: 'Record which pi / Claude session runs in every tab (also taken daily and on quit)',
      keywords: 'snapshot save backup sessions agents pi claude',
      enabled: true,
      run: () => saveSnapshotNow(),
    },
    {
      label: 'Restore Latest Snapshot…',
      detail: 'Re-open every pi / Claude session from the newest snapshot in its tab',
      keywords: 'snapshot restore reload resume sessions agents pi claude latest',
      enabled: true,
      run: () => restoreLatestSnapshot(),
    },
    {
      label: 'Restore Snapshot…',
      detail: 'Pick an older snapshot to restore',
      keywords: 'snapshot restore reload resume history older pick',
      enabled: true,
      run: () => pickAndRestoreSnapshot(),
    },
    {
      label: 'Set Worktree for Active Session…',
      detail: 'Choose a git worktree and assign it to the selected vertical tab',
      keywords: 'worktree branch pr cwd set active session',
      enabled: Boolean(activeSessionRecord()),
      run: () => setWorktreeForActiveSession(),
    },
    {
      label: 'Refresh Git/PR Status',
      detail: 'Re-read git branch and GitHub PR status for the selected tab',
      keywords: 'refresh git branch pr status',
      enabled: Boolean(activeSessionRecord()),
      run: () => refreshActiveSessionContext(),
    },
  ];
}

function openCommandPalette() {
  if (paletteEl) return;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay palette-overlay';
  overlay.innerHTML = `
    <div class="palette">
      <input class="palette-input" type="text" placeholder="Type a command…  (⏎ run · esc close)" spellcheck="false" />
      <div class="palette-list"></div>
    </div>`;
  paletteEl = overlay;

  const input = overlay.querySelector('.palette-input');
  const listEl = overlay.querySelector('.palette-list');
  let items = [];
  let sel = 0;

  function computeItems() {
    const q = input.value.trim().toLowerCase();
    items = commandItems()
      .filter((command) => command.enabled)
      .map((command) => ({ command, score: q ? scoreCommand(command, q) : 0 }))
      .filter((item) => !q || item.score > -Infinity)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.command);
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
  }

  function highlight() {
    [...listEl.children].forEach((child, i) => child.classList.toggle('active', i === sel));
    listEl.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = activeSessionRecord() ? 'No matching command.' : 'No active session.';
      listEl.appendChild(empty);
      return;
    }
    items.forEach((command, i) => {
      const row = document.createElement('div');
      row.className = 'palette-item' + (i === sel ? ' active' : '');
      const label = document.createElement('span');
      label.className = 'pi-name';
      label.textContent = command.label;
      const detail = document.createElement('span');
      detail.className = 'pi-path';
      detail.textContent = command.detail;
      row.append(label, detail);
      row.onmouseenter = () => {
        sel = i;
        highlight();
      };
      row.onclick = () => choose(command);
      listEl.appendChild(row);
    });
  }

  function close() {
    overlay.remove();
    paletteEl = null;
    document.removeEventListener('keydown', onKey, true);
  }

  async function choose(command) {
    close();
    await command.run();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) {
        sel = (sel + 1) % items.length;
        highlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) {
        sel = (sel - 1 + items.length) % items.length;
        highlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[sel]) choose(items[sel]);
    }
  }

  input.addEventListener('input', () => {
    computeItems();
    renderList();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  computeItems();
  renderList();
  input.focus();
}

async function setWorktreeForActiveSession() {
  const active = activeSessionRecord();
  if (!active) return;

  const worktrees = await api.listWorktrees(active.repo.cwd);
  if (!worktrees.length) {
    const picked = await api.pickFolder();
    if (!picked) return;
    active.session.cwd = picked.path;
    active.session.cwdSource = 'manual';
    active.session.worktreeLocked = true;
    if (!isManualName(active.session)) {
      active.session.name = picked.name;
      active.session.nameSource = 'manual';
      active.session.pinned = true;
    }
    await persist();
    scheduleContextRefresh(active.repo, active.session, 0);
    render();
    return;
  }

  await openWorktreePicker(active, worktrees);
}

function openWorktreePicker(active, worktrees) {
  return new Promise((resolve) => {
    if (paletteEl) return resolve(null);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay palette-overlay';
    overlay.innerHTML = `
      <div class="palette">
        <input class="palette-input" type="text" placeholder="Choose worktree for active session…" spellcheck="false" />
        <div class="palette-list"></div>
      </div>`;
    paletteEl = overlay;

    const input = overlay.querySelector('.palette-input');
    const listEl = overlay.querySelector('.palette-list');
    let items = [];
    let sel = 0;

    function itemText(ctx) {
      return [ctx.cwd, ctx.git?.branch, ctx.pr?.title, prLabel(ctx.pr)].filter(Boolean).join(' ');
    }

    function computeItems() {
      const q = input.value.trim().toLowerCase();
      items = !q
        ? worktrees.slice()
        : worktrees
            .map((ctx) => ({ ctx, score: fuzzyScore(itemText(ctx).toLowerCase(), q) }))
            .filter((item) => item.score > -Infinity)
            .sort((a, b) => b.score - a.score)
            .map((item) => item.ctx);
      if (sel >= items.length) sel = Math.max(0, items.length - 1);
    }

    function highlight() {
      [...listEl.children].forEach((child, i) => child.classList.toggle('active', i === sel));
      listEl.children[sel]?.scrollIntoView({ block: 'nearest' });
    }

    function renderList() {
      listEl.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'palette-empty';
        empty.textContent = 'No matching worktree.';
        listEl.appendChild(empty);
        return;
      }
      items.forEach((ctx, i) => {
        const row = document.createElement('div');
        row.className = 'palette-item worktree-item' + (i === sel ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'pi-name';
        name.textContent = `${ctx.isMainWorktree ? 'main' : contextTitle(ctx)}`;
        const detail = document.createElement('span');
        detail.className = 'pi-path';
        detail.textContent = `${gitLabel(ctx)} · ${prLabel(ctx.pr)} · ${prettyPath(ctx.cwd)}`;
        row.append(name, detail);
        row.onmouseenter = () => {
          sel = i;
          highlight();
        };
        row.onclick = () => choose(ctx);
        listEl.appendChild(row);
      });
    }

    function close(value = null) {
      overlay.remove();
      paletteEl = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    }

    async function choose(ctx) {
      active.session.cwd = ctx.cwd;
      active.session.cwdSource = 'manual';
      active.session.worktreeLocked = true;
      if (!isManualName(active.session)) {
        active.session.name = contextTitle(ctx);
        active.session.nameSource = 'manual';
        active.session.pinned = true;
      }
      sessionContexts.set(active.session.id, ctx);
      await persist();
      render();
      close(ctx);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length) {
          sel = (sel + 1) % items.length;
          highlight();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) {
          sel = (sel - 1 + items.length) % items.length;
          highlight();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[sel]) choose(items[sel]);
      }
    }

    input.addEventListener('input', () => {
      computeItems();
      renderList();
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    computeItems();
    renderList();
    input.focus();
  });
}

async function refreshActiveSessionContext() {
  const active = activeSessionRecord();
  if (!active) return;
  scheduleContextRefresh(active.repo, active.session, 0);
}

async function renameRepo(repoId) {
  const repo = state.repos.find((r) => r.id === repoId);
  if (!repo) return;
  const name = await promptModal('Rename scope', repo.name);
  if (name) {
    repo.name = name;
    await persist();
    render();
  }
}

async function removeRepo(repoId) {
  const repo = state.repos.find((r) => r.id === repoId);
  if (!repo) return;
  const ok = confirm(`Remove scope "${repo.name}" and kill its ${repo.sessions.length} session(s)?`);
  if (!ok) return;
  for (const s of repo.sessions) await destroySession(s, true);
  state.repos = state.repos.filter((r) => r.id !== repoId);
  delete state.activeSessionByRepo[repoId];
  if (state.activeRepoId === repoId) state.activeRepoId = state.repos[0]?.id || null;
  await persist();
  render();
}

async function addSession(repoId) {
  const repo = state.repos.find((r) => r.id === repoId);
  if (!repo) return;
  const session = {
    id: uid(),
    name: `session ${repo.sessions.length + 1}`,
    nameSource: 'default',
    cwd: repo.cwd,
    cwdSource: 'default',
    worktreeLocked: false,
    slug: newSlug(),
    pinned: false,
  };
  repo.sessions.push(session);
  state.activeRepoId = repoId;
  state.activeSessionByRepo[repoId] = session.id;
  await persist();
  render();
}

async function renameSession(repoId, sessionId) {
  const repo = state.repos.find((r) => r.id === repoId);
  const session = repo?.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  const name = await promptModal('Rename session', session.name);
  if (name) {
    session.name = name;
    session.nameSource = 'manual';
    session.pinned = true; // manual name wins; stop following auto/agent titles
    await persist();
    render();
  }
}

async function removeSession(repoId, sessionId) {
  const repo = state.repos.find((r) => r.id === repoId);
  const session = repo?.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  await destroySession(session, true);
  repo.sessions = repo.sessions.filter((s) => s.id !== sessionId);
  if (activeSessionId(repoId) === sessionId) {
    state.activeSessionByRepo[repoId] = repo.sessions[repo.sessions.length - 1]?.id || null;
  }
  await persist();
  render();
}

// Tear down the local xterm; optionally kill the session's shell too.
async function destroySession(session, killShell) {
  const pendingContext = contextTimers.get(session.id);
  if (pendingContext) clearTimeout(pendingContext);
  contextTimers.delete(session.id);
  contextRequests.delete(session.id);
  sessionContexts.delete(session.id);

  const entry = terminals.get(session.id);
  if (entry) {
    try {
      entry.term.dispose();
    } catch {
      /* noop */
    }
    entry.el.remove();
    ptyToSession.delete(entry.ptyId);
    terminals.delete(session.id);
  }
  if (killShell) {
    await api.killSession(session.slug, entry?.ptyId || null);
    liveSlugs.delete(session.slug);
  }
}

// ---------- selection ----------
async function selectRepo(repoId) {
  state.activeRepoId = repoId;
  const repo = state.repos.find((r) => r.id === repoId);
  const session = repo?.sessions.find((s) => s.id === activeSessionId(repoId));
  if (repo && session) scheduleContextRefresh(repo, session, 0);
  await persist();
  render();
}
async function selectSession(repoId, sessionId) {
  state.activeRepoId = repoId;
  state.activeSessionByRepo[repoId] = sessionId;
  const repo = state.repos.find((r) => r.id === repoId);
  const session = repo?.sessions.find((s) => s.id === sessionId);
  if (repo && session) scheduleContextRefresh(repo, session, 0);
  await persist();
  render();
}

// Move up (-1) / down (+1) the active scope's session list, wrapping around.
function cycleSession(dir) {
  const repo = activeRepo();
  const sessions = repo ? visibleSessions(repo) : [];
  if (!sessions.length) return;
  let idx = sessions.findIndex((s) => s.id === activeSessionId(repo.id));
  if (idx === -1) idx = dir > 0 ? -1 : 0;
  const n = sessions.length;
  const nextIdx = (idx + dir + n) % n;
  selectSession(repo.id, sessions[nextIdx].id);
}

function updateSessionActivityDot(sessionId) {
  const dot = document.querySelector(`.dot[data-sid="${sessionId}"]`);
  if (dot) dot.classList.toggle('busy', busySessionIds.has(sessionId));
}

function markSessionBusy(sessionId) {
  if (!sessionId) return;
  busySessionIds.add(sessionId);
  updateSessionActivityDot(sessionId);

  const existing = busyTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  busyTimers.set(
    sessionId,
    setTimeout(() => {
      busyTimers.delete(sessionId);
      busySessionIds.delete(sessionId);
      updateSessionActivityDot(sessionId);
    }, 1800)
  );
}

function moveSession(repoId, draggedSessionId, targetSessionId, placeAfterTarget) {
  if (!draggedSessionId || !targetSessionId || draggedSessionId === targetSessionId) return;
  const repo = state.repos.find((r) => r.id === repoId);
  if (!repo) return;

  const fromIndex = repo.sessions.findIndex((s) => s.id === draggedSessionId);
  if (fromIndex === -1) return;

  const [moved] = repo.sessions.splice(fromIndex, 1);
  const targetIndex = repo.sessions.findIndex((s) => s.id === targetSessionId);
  if (targetIndex === -1) {
    repo.sessions.splice(fromIndex, 0, moved);
    return;
  }

  repo.sessions.splice(placeAfterTarget ? targetIndex + 1 : targetIndex, 0, moved);
  persist();
  render();
}

// Move left (-1) / right (+1) across the scope tabs, wrapping around.
function cycleRepo(dir) {
  if (state.repos.length === 0) return;
  let idx = state.repos.findIndex((r) => r.id === state.activeRepoId);
  if (idx === -1) idx = 0;
  const n = state.repos.length;
  const nextIdx = (idx + dir + n) % n;
  selectRepo(state.repos[nextIdx].id);
}

function isMacLikePlatform() {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
}

function shouldOpenTerminalLink(event) {
  return isMacLikePlatform() ? event.metaKey : event.ctrlKey;
}

function openTerminalLink(event, uri) {
  if (!shouldOpenTerminalLink(event)) return;
  event.preventDefault();
  event.stopPropagation();
  void api.openExternalUrl(uri).catch(() => {
    // Best effort: invalid/unopenable links are rejected by the main process.
  });
}

// ---------- terminal lifecycle ----------
function ensureTerminal(repo, session, options = {}) {
  const existing = terminals.get(session.id);
  if (existing) return Promise.resolve(existing);
  if (!terminalStarts.has(session.id)) {
    const start = startTerminal(repo, session, options).finally(() => terminalStarts.delete(session.id));
    terminalStarts.set(session.id, start);
  }
  return terminalStarts.get(session.id);
}

async function startTerminal(repo, session, { background = false } = {}) {
  const initialCommand = pendingInitialCommands.get(session.id) || null;
  pendingInitialCommands.delete(session.id);

  const wrap = document.createElement('div');
  wrap.className = 'term';
  // Active session is about to be shown; background starts (restore) stay hidden.
  wrap.style.display = background ? 'none' : 'block';
  el.terminals.appendChild(wrap);

  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    theme: { background: '#0e0f13', foreground: '#e6e6e6', cursor: '#6d8cff' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon(openTerminalLink));
  term.open(wrap);
  try {
    fit.fit();
  } catch {
    /* not measurable yet */
  }

  const { ptyId } = await api.startSession({
    slug: session.slug,
    cwd: session.cwd || repo.cwd,
    cols: term.cols,
    rows: term.rows,
    initialCommand,
  });

  const entry = {
    term,
    fit,
    ptyId,
    el: wrap,
    slug: session.slug,
    lastCols: term.cols,
    lastRows: term.rows,
    kittyStack: [], // kitty keyboard-protocol flags the running app has pushed
    kbTail: '', // carry an incomplete trailing escape across data chunks
    oscTail: '', // carry an incomplete OSC 7 cwd sequence across data chunks
  };
  terminals.set(session.id, entry);
  ptyToSession.set(ptyId, session.id);
  liveSlugs.add(session.slug);

  // Let ⌘ shortcuts reach the app instead of being consumed by xterm.
  term.attachCustomKeyEventHandler((e) => !e.metaKey);

  term.onData((data) => api.writeSession(ptyId, data));
  term.onResize(({ cols, rows }) => api.resizeSession(ptyId, cols, rows));
  term.onTitleChange((title) => applyAutoTitle(session, title));

  return entry;
}

// The sidebar and topbar are rebuilt wholesale on render (selecting a tab, git/PR
// refreshes for every tab on window focus, agent titles). If a rebuild lands
// between press and release, the browser drops the click (and any dblclick).
// So detect double-clicks from mousedown on the persistent container, keyed by
// the item's id rather than its DOM node.
const DOUBLE_CLICK_MS = 500;

function onDoubleClickById(container, idOf, handler) {
  let last = { id: null, at: 0 };
  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const id = idOf(e.target);
    if (!id) return;
    if (id === last.id && e.timeStamp - last.at <= DOUBLE_CLICK_MS) {
      last = { id: null, at: 0 };
      e.preventDefault(); // don't let this press pull focus away from the rename input
      handler(id);
    } else {
      last = { id, at: e.timeStamp };
    }
  });
}

function initDoubleClickRename() {
  onDoubleClickById(
    el.sidebar,
    (target) => target.closest('.session-content') && target.closest('.session')?.dataset.sid,
    (sid) => {
      const repo = state.repos.find((r) => r.sessions.some((s) => s.id === sid));
      if (repo) renameSession(repo.id, sid);
    }
  );
  onDoubleClickById(el.topbar, (target) => target.closest('.chip-label')?.dataset.repoId, renameRepo);
}

function renameActiveSession() {
  const active = activeSessionRecord();
  if (active) renameSession(active.repo.id, active.session.id);
}

// ---------- tags ----------
function visibleSessions(repo) {
  return tagFilter ? repo.sessions.filter((s) => hasTag(s.tags, tagFilter)) : repo.sessions;
}

function tagDot(color) {
  const dot = document.createElement('span');
  dot.className = 'tag-dot';
  dot.style.setProperty('--tag-color', color);
  return dot;
}

// Searchable tag picker: existing tags from the list plus a "create" row for
// whatever was typed. Resolves to { name, create } or null.
function tagPickerModal(currentTags) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay palette-overlay';
    overlay.innerHTML = `<div class="palette"><input class="palette-input" type="text" spellcheck="false" placeholder="Add tag — type to search or create  (⏎ add · esc close)" /><div class="palette-list"></div></div>`;
    const input = overlay.querySelector('.palette-input');
    const listEl = overlay.querySelector('.palette-list');
    let rows = [];
    let sel = 0;

    const close = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    const highlight = () => {
      [...listEl.children].forEach((c, i) => c.classList.toggle('active', i === sel));
      listEl.children[sel]?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (row) => close({ name: row.name, create: row.kind === 'create' });
    function renderRows() {
      rows = tagPickerRows(state.tags, input.value, currentTags);
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      listEl.innerHTML = '';
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'palette-empty';
        empty.textContent = 'This tab already has every tag. Type a name to create a new one.';
        listEl.appendChild(empty);
        return;
      }
      rows.forEach((row, i) => {
        const item = document.createElement('div');
        item.className = 'palette-item' + (i === sel ? ' active' : '');
        const label = document.createElement('span');
        label.className = 'pi-name';
        label.textContent = row.kind === 'create' ? `Create tag “${row.name}”` : row.name;
        const detail = document.createElement('span');
        detail.className = 'pi-path';
        detail.textContent = row.kind === 'create' ? 'adds it to the tag list' : pluralize(tagUsageCount(state.repos, row.name), 'tab');
        item.append(tagDot(row.color), label, detail);
        item.onmouseenter = () => {
          sel = i;
          highlight();
        };
        item.onclick = () => pick(row);
        listEl.appendChild(item);
      });
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'ArrowDown' && rows.length) {
        e.preventDefault();
        sel = (sel + 1) % rows.length;
        highlight();
      } else if (e.key === 'ArrowUp' && rows.length) {
        e.preventDefault();
        sel = (sel - 1 + rows.length) % rows.length;
        highlight();
      } else if (e.key === 'Enter' && rows[sel]) {
        e.preventDefault();
        pick(rows[sel]);
      }
    }
    input.addEventListener('input', () => {
      sel = 0;
      renderRows();
    });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    renderRows();
    input.focus();
  });
}

async function addTagToActiveSession() {
  const active = activeSessionRecord();
  if (!active) return;
  const picked = await tagPickerModal(active.session.tags || []);
  if (!picked) return;
  const tag = ensureTag(state.tags, picked.name);
  if (!tag) return;
  active.session.tags = sortByLibrary(withTag(active.session.tags, tag.name), state.tags);
  await persist();
  render();
}

async function removeSessionTag(sessionId, name) {
  const found = findSession(sessionId);
  if (!found) return;
  found.session.tags = withoutTag(found.session.tags, name);
  if (tagFilter && tagKey(tagFilter) === tagKey(name) && !visibleSessions(found.repo).length) tagFilter = null;
  await persist();
  render();
}

async function removeTagFromActiveSession() {
  const active = activeSessionRecord();
  if (!active?.session.tags?.length) return;
  const name = await listPickerModal(
    'Remove which tag from this tab?',
    active.session.tags.map((t) => ({ label: t, detail: '', value: t }))
  );
  if (name) await removeSessionTag(active.session.id, name);
}

async function pickTagFilter() {
  const repo = activeRepo();
  const rows = state.tags.map((t) => ({
    label: t.name,
    detail: repo ? pluralize(repo.sessions.filter((s) => hasTag(s.tags, t.name)).length, 'tab') + ' here' : '',
    value: t.name,
  }));
  if (tagFilter) rows.unshift({ label: 'Show all tabs', detail: `clear the “${tagFilter}” filter`, value: '' });
  const value = await listPickerModal('Show only tabs tagged…', rows);
  if (value === null) return;
  setTagFilter(value || null);
}

function setTagFilter(name) {
  tagFilter = name;
  const repo = activeRepo();
  // Keep the selection on a visible tab so the terminal matches the list.
  if (repo && name) {
    const visible = visibleSessions(repo);
    if (visible.length && !visible.some((s) => s.id === activeSessionId(repo.id))) {
      selectSession(repo.id, visible[0].id);
      return;
    }
  }
  render();
}

async function deleteTagFromList() {
  const name = await listPickerModal(
    'Delete which tag from the list?',
    state.tags.map((t) => ({ label: t.name, detail: pluralize(tagUsageCount(state.repos, t.name), 'tab'), value: t.name }))
  );
  if (!name) return;
  const used = tagUsageCount(state.repos, name);
  if (used && !(await confirmModal(`Delete tag “${name}”?`, [`It will be removed from ${pluralize(used, 'tab')}.`], 'Delete'))) return;
  state.tags = state.tags.filter((t) => tagKey(t.name) !== tagKey(name));
  for (const repo of state.repos) for (const session of repo.sessions) session.tags = withoutTag(session.tags, name);
  if (tagFilter && tagKey(tagFilter) === tagKey(name)) tagFilter = null;
  await persist();
  render();
}

function renderTagPill(session, name) {
  const pill = document.createElement('span');
  pill.className = 'session-tag';
  pill.style.setProperty('--tag-color', tagColor(state.tags, name));
  pill.title = `Tag: ${name}`;
  const label = document.createElement('span');
  label.textContent = name;
  const x = document.createElement('button');
  x.className = 'session-tag-x';
  x.textContent = '×';
  x.title = `Remove “${name}”`;
  // Don't let the press select the row or count toward a rename double-click.
  x.onmousedown = (e) => e.stopPropagation();
  x.onclick = (e) => {
    e.stopPropagation();
    removeSessionTag(session.id, name);
  };
  pill.append(label, x);
  return pill;
}

// ---------- render ----------
function render() {
  renderTopbar();
  renderSidebar();
  renderStatusbar();
  mountActive();
}

function renderTopbar() {
  el.topbar.innerHTML = '';
  for (const repo of state.repos) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (repo.id === state.activeRepoId ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = repo.name;
    label.title = repo.cwd;
    label.dataset.repoId = repo.id;
    label.onclick = () => selectRepo(repo.id);

    const x = document.createElement('button');
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = 'Remove scope';
    x.onclick = (e) => {
      e.stopPropagation();
      removeRepo(repo.id);
    };

    chip.append(label, x);
    el.topbar.appendChild(chip);
  }

  const add = document.createElement('button');
  add.className = 'chip chip-add';
  add.textContent = '+';
  add.title = 'Open a repo (⌘P)';
  add.onclick = openPalette;
  el.topbar.appendChild(add);
}

function renderSidebar() {
  el.sidebar.innerHTML = '';
  const repo = activeRepo();
  if (!repo) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Add a scope to begin.';
    el.sidebar.appendChild(hint);
    return;
  }

  const list = document.createElement('div');
  list.className = 'session-list';
  const activeSid = activeSessionId(repo.id);

  let draggedSessionId = null;

  function clearDropTargets() {
    list.querySelectorAll('.session.drop-before, .session.drop-after').forEach((node) => {
      node.classList.remove('drop-before', 'drop-after');
    });
  }

  if (tagFilter) {
    const banner = document.createElement('div');
    banner.className = 'tag-filter';
    const label = document.createElement('span');
    label.className = 'tag-filter-label';
    label.append('Showing ');
    const pill = document.createElement('span');
    pill.className = 'session-tag';
    pill.style.setProperty('--tag-color', tagColor(state.tags, tagFilter));
    pill.textContent = tagFilter;
    label.append(pill, ` · ${visibleSessions(repo).length}/${repo.sessions.length}`);
    const clear = document.createElement('button');
    clear.className = 'tag-filter-clear';
    clear.textContent = 'Show all';
    clear.onclick = () => setTagFilter(null);
    banner.append(label, clear);
    list.appendChild(banner);
  }

  for (const s of visibleSessions(repo)) {
    const item = document.createElement('div');
    item.className = 'session' + (s.id === activeSid ? ' active' : '');
    item.dataset.sid = s.id;
    item.draggable = true;

    item.addEventListener('dragstart', (e) => {
      draggedSessionId = s.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', s.id);
    });
    item.addEventListener('dragend', () => {
      draggedSessionId = null;
      item.classList.remove('dragging');
      clearDropTargets();
    });
    item.addEventListener('dragover', (e) => {
      if (!draggedSessionId || draggedSessionId === s.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const placeAfter = e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
      clearDropTargets();
      item.classList.add(placeAfter ? 'drop-after' : 'drop-before');
    });
    item.addEventListener('drop', (e) => {
      if (!draggedSessionId || draggedSessionId === s.id) return;
      e.preventDefault();
      const placeAfter = e.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
      moveSession(repo.id, draggedSessionId, s.id, placeAfter);
    });

    const ctx = sessionContexts.get(s.id);
    if (!ctx && !contextTimers.has(s.id)) scheduleContextRefresh(repo, s, 50);

    const dot = document.createElement('span');
    dot.className = 'dot' + (liveSlugs.has(s.slug) ? ' live' : '') + (busySessionIds.has(s.id) ? ' busy' : '');
    dot.dataset.sid = s.id;

    const content = document.createElement('div');
    content.className = 'session-content';
    content.onclick = () => selectSession(repo.id, s.id);

    const name = document.createElement('span');
    name.className = 'session-name';
    name.dataset.sid = s.id;
    name.textContent = s.name;
    name.title = contextTooltip(s, ctx);

    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.title = contextTooltip(s, ctx);

    for (const tagName of s.tags || []) meta.appendChild(renderTagPill(s, tagName));

    const branch = document.createElement('span');
    branch.className = 'session-branch';
    branch.textContent = gitLabel(ctx);
    meta.appendChild(branch);

    if (ctx?.git?.isRepo) {
      const pr = document.createElement('button');
      pr.className = `session-pr ${prClass(ctx.pr)}`;
      pr.textContent = prLabel(ctx.pr);
      pr.title = ctx.pr?.lookupState === 'found' ? `${ctx.pr.title}\n${ctx.pr.url}` : prLabel(ctx.pr);
      pr.disabled = ctx.pr?.lookupState !== 'found' || !ctx.pr.url;
      pr.onclick = (e) => {
        e.stopPropagation();
        if (ctx.pr?.url) void api.openExternalUrl(ctx.pr.url).catch(() => {});
      };
      meta.appendChild(pr);
    }

    content.append(name, meta);

    const x = document.createElement('button');
    x.className = 'session-x';
    x.textContent = '×';
    x.title = 'Remove session';
    x.onclick = (e) => {
      e.stopPropagation();
      removeSession(repo.id, s.id);
    };

    item.append(dot, content, x);
    list.appendChild(item);
  }
  el.sidebar.appendChild(list);

  const add = document.createElement('button');
  add.className = 'btn btn-add-session';
  add.textContent = '+ New session';
  add.onclick = () => addSession(repo.id);
  el.sidebar.appendChild(add);
}

function renderStatusbar() {
  el.statusbar.innerHTML = '';
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  const session = sid ? repo.sessions.find((s) => s.id === sid) : null;
  if (!repo || !session) {
    el.statusbar.classList.add('empty-status');
    el.statusbar.textContent = '';
    return;
  }

  el.statusbar.classList.remove('empty-status');
  const ctx = sessionContexts.get(session.id);
  if (!ctx && !contextTimers.has(session.id)) scheduleContextRefresh(repo, session, 50);

  const parts = [];
  const repoName = document.createElement('span');
  repoName.className = 'status-repo';
  repoName.textContent = repo.name;
  parts.push(repoName);

  const cwd = document.createElement('span');
  cwd.className = 'status-cwd';
  cwd.textContent = prettyPath(session.cwd || repo.cwd);
  cwd.title = session.cwd || repo.cwd;
  parts.push(cwd);

  const branch = document.createElement('span');
  branch.className = 'status-branch';
  branch.textContent = gitLabel(ctx);
  branch.title = ctx?.git?.isRepo ? ctx.git.worktreeRoot : '';
  parts.push(branch);

  if (ctx?.git?.isRepo) {
    const pr = document.createElement('button');
    pr.className = `status-pr ${prClass(ctx.pr)}`;
    pr.textContent = prLabel(ctx.pr);
    pr.disabled = ctx.pr?.lookupState !== 'found' || !ctx.pr.url;
    pr.title = ctx.pr?.lookupState === 'found' ? `${ctx.pr.title}\n${ctx.pr.url}` : prLabel(ctx.pr);
    pr.onclick = () => {
      if (ctx.pr?.url) void api.openExternalUrl(ctx.pr.url).catch(() => {});
    };
    parts.push(pr);
  }

  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'status-sep';
      sep.textContent = '·';
      el.statusbar.appendChild(sep);
    }
    el.statusbar.appendChild(part);
  });
}

async function mountActive() {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;

  el.empty.style.display = sid ? 'none' : 'flex';

  // Hide everything first; we reveal the active one after it's ensured.
  for (const entry of terminals.values()) entry.el.style.display = 'none';

  if (!repo || !sid) return;
  const session = repo.sessions.find((s) => s.id === sid);
  if (!session) return;

  const entry = await ensureTerminal(repo, session);
  // Guard against a race where selection changed while awaiting.
  if (activeSessionId(activeRepo()?.id) !== sid) return;

  entry.el.style.display = 'block';
  requestAnimationFrame(() => {
    fitEntry(entry);
    entry.term.focus();
  });
}

// ---------- global events ----------
// Fit a terminal to its container, telling the pty only when the size actually
// changed. Each session is a shell pty talking straight to xterm, so a resize
// just SIGWINCHes the program and it repaints itself — no relay, no redraw hacks.
function fitEntry(entry) {
  if (!entry) return;
  try {
    entry.fit.fit();
  } catch {
    /* not measurable */
  }
  const { cols, rows } = entry.term;
  if (cols > 0 && rows > 0 && (cols !== entry.lastCols || rows !== entry.lastRows)) {
    entry.lastCols = cols;
    entry.lastRows = rows;
    api.resizeSession(entry.ptyId, cols, rows);
  }
}

// Refit the visible terminal.
function fitActive() {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  fitEntry(sid ? terminals.get(sid) : null);
}

// Kitty keyboard protocol (https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
// xterm.js doesn't implement it, so VibeDeck plays the terminal side: track the
// flags an app pushes/pops and answer its support query. That lets modified keys
// — notably Shift+Enter — be sent unambiguously as CSI-u, so a newline works in
// any app that speaks the protocol (pi, etc.), the way Warp does natively.
function currentKittyFlags(entry) {
  const s = entry.kittyStack;
  return s.length ? s[s.length - 1] : 0;
}

function parseOsc7Cwd(payload) {
  const raw = String(payload || '').trim();
  if (!raw) return null;
  if (!raw.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(raw).pathname);
  } catch {
    const withoutScheme = raw.replace(/^file:\/\/[^/]*/, '');
    try {
      return decodeURIComponent(withoutScheme);
    } catch {
      return withoutScheme;
    }
  }
}

function trackSessionCwd(entry, data, sessionId) {
  const found = findSession(sessionId);
  if (!found) return;
  const buf = (entry.oscTail || '') + data;
  const re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match;
  let latestCwd = null;
  while ((match = re.exec(buf))) {
    const cwd = parseOsc7Cwd(match[1]);
    if (cwd && cwd.startsWith('/')) latestCwd = cwd;
  }

  const lastStart = buf.lastIndexOf('\x1b]7;');
  const lastBel = buf.lastIndexOf('\x07');
  const lastSt = buf.lastIndexOf('\x1b\\');
  entry.oscTail = lastStart > Math.max(lastBel, lastSt) ? buf.slice(lastStart, lastStart + 512) : '';

  if (!latestCwd || found.session.worktreeLocked || found.session.cwdSource === 'manual') return;
  const changed = found.session.cwd !== latestCwd;
  const becameObserved = found.session.cwdSource !== 'observed';
  found.session.cwd = latestCwd;
  found.session.cwdSource = 'observed';
  if (!changed && !becameObserved) return;
  persistSoon();
  scheduleContextRefresh(found.repo, found.session, 100);
  renderStatusbar();
}

function trackKittyKeyboard(entry, data) {
  const buf = (entry.kbTail || '') + data;
  let m;
  const push = /\x1b\[>([0-9]*)u/g; // CSI > flags u  — enable/push
  while ((m = push.exec(buf))) entry.kittyStack.push(Number(m[1] || 0));
  const pop = /\x1b\[<([0-9]*)u/g; // CSI < number u — pop (default 1)
  while ((m = pop.exec(buf))) {
    let n = Number(m[1] || 1);
    while (n-- > 0) entry.kittyStack.pop();
  }
  const set = /\x1b\[=([0-9]*)(?:;[0-9]*)?u/g; // CSI = flags ; mode u — set current
  while ((m = set.exec(buf))) {
    const f = Number(m[1] || 0);
    if (entry.kittyStack.length) entry.kittyStack[entry.kittyStack.length - 1] = f;
    else entry.kittyStack.push(f);
  }
  // CSI ? u — the app is asking whether we support the protocol; reply with the
  // current flags. Replying at all is what signals support (like a real terminal).
  if (/\x1b\[\?u/.test(buf)) api.writeSession(entry.ptyId, `\x1b[?${currentKittyFlags(entry)}u`);

  // Keep only an incomplete trailing escape, so a sequence split across chunks is
  // still matched next time — and a complete one is never re-scanned (counted twice).
  const i = buf.lastIndexOf('\x1b');
  entry.kbTail = i !== -1 && !/[A-Za-z~]/.test(buf.slice(i + 1)) ? buf.slice(i, i + 16) : '';
}

window.addEventListener('resize', fitActive);
window.addEventListener('focus', () => refreshAllSessionContexts(0));

// Draggable divider: resize the sidebar, persist the width, refit live.
function applySidebarWidth() {
  const w = Math.max(140, Math.min(900, state.sidebarWidth || 210));
  el.sidebar.style.width = w + 'px';
}

function initResizer() {
  let startX = 0;
  let startW = 0;
  let dragging = false;
  let raf = null;

  el.resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = el.sidebar.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const max = Math.min(900, window.innerWidth - 240);
    const w = Math.max(140, Math.min(max, startW + (e.clientX - startX)));
    state.sidebarWidth = Math.round(w);
    el.sidebar.style.width = state.sidebarWidth + 'px';
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = null;
        fitActive();
      });
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    persist();
    fitActive();
  });
}

// All keyboard shortcuts are handled in the main process (before-input-event)
// and arrive via api.onMenu above — the only place that reliably catches keys
// Chromium/xterm would otherwise claim (⌘P / ⌘T / ⌘1-9 / ⌘⌥ arrows / ⌘⇧[ ]).

// ---------- init ----------
async function init() {
  initDoubleClickRename();
  // Route pty output to terminals (registered once, before any session starts).
  api.onData(({ ptyId, data }) => {
    const sessionId = ptyToSession.get(ptyId);
    const entry = sessionId && terminals.get(sessionId);
    if (!entry) return;
    markSessionBusy(sessionId);
    trackSessionCwd(entry, data, sessionId); // follow the shell's actual cwd/worktree
    trackKittyKeyboard(entry, data); // watch the app's keyboard-protocol negotiation
    // Follow the tail: if the user is already at the bottom, keep them there after
    // this output — so a full redraw (e.g. an app's /reload) lands on the latest
    // state instead of jumping to the top of the scrollback. If they've scrolled
    // up to read history, leave the viewport alone.
    const buf = entry.term.buffer.active;
    const wasBottom = buf.viewportY >= buf.baseY;
    entry.term.write(data, () => {
      if (wasBottom) {
        try {
          entry.term.scrollToBottom();
        } catch {
          /* noop */
        }
      }
    });
  });
  api.onExit(({ ptyId }) => {
    const sessionId = ptyToSession.get(ptyId);
    const entry = sessionId && terminals.get(sessionId);
    if (entry) entry.term.write('\r\n\x1b[90m[process exited — reopen to restart]\x1b[0m\r\n');
  });
  api.onExternalContextUpdate((update) => applyExternalContextUpdate(update));

  // Shortcuts routed from the native menu (main process).
  api.onMenu(async (action) => {
    if (paletteEl && action !== 'palette' && action !== 'command-palette') return;
    const repo = activeRepo();
    if (action === 'snapshot-save') saveSnapshotNow();
    else if (action === 'snapshot-restore-latest') restoreLatestSnapshot();
    else if (action === 'palette') openPalette();
    else if (action === 'command-palette') openCommandPalette();
    else if (action === 'new-session') {
      if (repo) addSession(repo.id);
    } else if (action === 'close-session') {
      const sid = repo ? activeSessionId(repo.id) : null;
      if (repo && sid) removeSession(repo.id, sid);
    } else if (action === 'prev-scope') cycleRepo(-1);
    else if (action === 'next-scope') cycleRepo(1);
    else if (action === 'prev-session') cycleSession(-1);
    else if (action === 'next-session') cycleSession(1);
    else if (action === 'copy') {
      const entry = activeEntry();
      if (entry && entry.term.hasSelection()) api.clipWrite(entry.term.getSelection());
    } else if (action === 'paste') {
      const entry = activeEntry();
      if (entry) {
        // Prefer a clipboard image: type its temp-file path (like a drag-and-drop)
        // so Claude Code / pi attach it. Fall back to a normal text paste.
        const imgPath = await api.clipReadImage();
        if (imgPath) api.writeSession(entry.ptyId, imgPath + ' ');
        else {
          const text = await api.clipRead();
          if (text) entry.term.paste(text);
        }
      }
    } else if (action === 'select-all') {
      activeEntry()?.term.selectAll();
    } else if (action === 'newline') {
      const entry = activeEntry();
      if (entry) {
        // Kitty-aware apps (pi) need a CSI-u Shift+Enter; others (Claude Code, a
        // plain shell) take the legacy Alt+Enter. Both insert a newline.
        const seq = currentKittyFlags(entry) ? '\x1b[13;2u' : '\x1b\r';
        api.writeSession(entry.ptyId, seq);
      }
    } else if (action.startsWith('session:')) {
      const s = repo ? visibleSessions(repo)[Number(action.slice(8)) - 1] : null;
      if (s) selectSession(repo.id, s.id);
    }
  });

  try {
    const info = await api.hostInfo();
    hostname = info.hostname || '';
    homedir = info.homedir || '';
  } catch {
    /* non-fatal */
  }

  const loaded = await api.loadState();
  if (loaded && Array.isArray(loaded.repos)) state = loaded;
  normalizeStateShape();
  liveSlugs = new Set(await api.listSessions());
  refreshAllSessionContexts();
  applySidebarWidth();
  initResizer();
  render();
  // Nothing runs in a fresh launch — offer to bring the last snapshot back.
  restoreLatestSnapshot({ launchOffer: true }).catch(() => {});
}

init();
