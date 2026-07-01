'use strict';

/* globals Terminal, FitAddon */

// VibeDeck renderer. Owns the scope -> session model, renders the two-axis UI,
// and lazily attaches an xterm <-> pty <-> tmux pipe per session on demand.

const api = window.api;

let state = { repos: [], activeRepoId: null, activeSessionByRepo: {} };
let liveSlugs = new Set(); // tmux sessions alive on our socket right now
let hostname = ''; // used to ignore tmux's default (hostname) pane title

// sessionId -> { term, fit, ptyId, el }
const terminals = new Map();
// ptyId -> sessionId, to route incoming pty data to the right terminal
const ptyToSession = new Map();

const el = {
  topbar: document.getElementById('topbar'),
  sidebar: document.getElementById('sidebar'),
  terminals: document.getElementById('terminals'),
  empty: document.getElementById('empty'),
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

// Auto-naming: a session's display name follows the terminal title the running
// program sets (e.g. Claude Code), unless the user pinned a name. Filters out
// tmux's default (hostname) title and bare/idle shell titles so they don't
// clobber a meaningful name.
function cleanAutoTitle(raw) {
  const t = (raw || '').trim();
  if (!t) return null;
  if (hostname && t === hostname) return null; // tmux's default pane title
  if (/^-?(zsh|bash|sh|fish|dash|tcsh|ksh)$/i.test(t)) return null; // idle shell
  if (/^[^\s@]+@[^\s:]+:/.test(t)) return null; // user@host:path idle title
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}

function applyAutoTitle(session, rawTitle) {
  if (session.pinned) return;
  const cleaned = cleanAutoTitle(rawTitle);
  if (!cleaned || cleaned === session.name) return;
  session.name = cleaned;
  const label = document.querySelector(`.session-name[data-sid="${session.id}"]`);
  if (label) {
    label.textContent = cleaned;
    label.title = cleaned;
  }
  persistSoon();
}
function activeRepo() {
  return state.repos.find((r) => r.id === state.activeRepoId) || null;
}
function activeSessionId(repoId) {
  return state.activeSessionByRepo[repoId] || null;
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

// ---------- mutations ----------
async function addRepo() {
  const picked = await api.pickFolder();
  if (!picked) return;
  const repo = { id: uid(), name: picked.name, cwd: picked.path, sessions: [] };
  state.repos.push(repo);
  state.activeRepoId = repo.id;
  await persist();
  render();
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
    session.pinned = true; // manual name wins; stop following the auto-title
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
    state.activeSessionByRepo[repoId] = repo.sessions[0]?.id || null;
  }
  await persist();
  render();
}

// Tear down the local xterm; optionally destroy the backing tmux session.
async function destroySession(session, killTmux) {
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
  if (killTmux) {
    await api.killSession(session.slug, entry?.ptyId || null);
    liveSlugs.delete(session.slug);
  }
}

// ---------- selection ----------
async function selectRepo(repoId) {
  state.activeRepoId = repoId;
  await persist();
  render();
}
async function selectSession(repoId, sessionId) {
  state.activeRepoId = repoId;
  state.activeSessionByRepo[repoId] = sessionId;
  await persist();
  render();
}

// Move up (-1) / down (+1) the active scope's session list, wrapping around.
function cycleSession(dir) {
  const repo = activeRepo();
  if (!repo || repo.sessions.length === 0) return;
  let idx = repo.sessions.findIndex((s) => s.id === activeSessionId(repo.id));
  if (idx === -1) idx = 0;
  const n = repo.sessions.length;
  const nextIdx = (idx + dir + n) % n;
  selectSession(repo.id, repo.sessions[nextIdx].id);
}

// ---------- terminal lifecycle ----------
async function ensureTerminal(repo, session) {
  const existing = terminals.get(session.id);
  if (existing) return existing;

  const wrap = document.createElement('div');
  wrap.className = 'term';
  wrap.style.display = 'block'; // active session is about to be shown
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
  term.open(wrap);
  try {
    fit.fit();
  } catch {
    /* not measurable yet */
  }

  const { ptyId } = await api.startSession({
    slug: session.slug,
    cwd: repo.cwd,
    cols: term.cols,
    rows: term.rows,
  });

  const entry = { term, fit, ptyId, el: wrap };
  terminals.set(session.id, entry);
  ptyToSession.set(ptyId, session.id);
  liveSlugs.add(session.slug);

  term.onData((data) => api.writeSession(ptyId, data));
  term.onResize(({ cols, rows }) => api.resizeSession(ptyId, cols, rows));
  term.onTitleChange((title) => applyAutoTitle(session, title));

  return entry;
}

// ---------- render ----------
function render() {
  renderTopbar();
  renderSidebar();
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
    label.onclick = () => selectRepo(repo.id);
    label.ondblclick = () => renameRepo(repo.id);

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
  add.title = 'Add scope (choose a folder)';
  add.onclick = addRepo;
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

  for (const s of repo.sessions) {
    const item = document.createElement('div');
    item.className = 'session' + (s.id === activeSid ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'dot' + (liveSlugs.has(s.slug) ? ' live' : '');

    const name = document.createElement('span');
    name.className = 'session-name';
    name.dataset.sid = s.id;
    name.textContent = s.name;
    name.title = s.pinned ? s.name : `${s.name} (auto-named — double-click to rename)`;
    name.onclick = () => selectSession(repo.id, s.id);
    name.ondblclick = () => renameSession(repo.id, s.id);

    const x = document.createElement('button');
    x.className = 'session-x';
    x.textContent = '×';
    x.title = 'Remove session';
    x.onclick = (e) => {
      e.stopPropagation();
      removeSession(repo.id, s.id);
    };

    item.append(dot, name, x);
    list.appendChild(item);
  }
  el.sidebar.appendChild(list);

  const add = document.createElement('button');
  add.className = 'btn btn-add-session';
  add.textContent = '+ New session';
  add.onclick = () => addSession(repo.id);
  el.sidebar.appendChild(add);
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
    try {
      entry.fit.fit();
    } catch {
      /* noop */
    }
    entry.term.focus();
    api.resizeSession(entry.ptyId, entry.term.cols, entry.term.rows);
  });
}

// ---------- global events ----------
window.addEventListener('resize', () => {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  const entry = sid ? terminals.get(sid) : null;
  if (!entry) return;
  try {
    entry.fit.fit();
  } catch {
    /* noop */
  }
  api.resizeSession(entry.ptyId, entry.term.cols, entry.term.rows);
});

window.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  const repo = activeRepo();

  // ⌘⇧[ / ⌘⇧] — previous / next session (up / down the session list).
  // Match on the physical bracket key so Shift's char remap ([ -> {) is moot.
  if (e.shiftKey) {
    const isLeft = e.code === 'BracketLeft' || e.key === '[' || e.key === '{';
    const isRight = e.code === 'BracketRight' || e.key === ']' || e.key === '}';
    if (isLeft) {
      e.preventDefault();
      cycleSession(-1);
      return;
    }
    if (isRight) {
      e.preventDefault();
      cycleSession(1);
      return;
    }
  }

  if (e.key === 't') {
    if (repo) {
      e.preventDefault();
      addSession(repo.id);
    }
  } else if (/^[1-9]$/.test(e.key)) {
    const s = repo?.sessions[Number(e.key) - 1];
    if (s) {
      e.preventDefault();
      selectSession(repo.id, s.id);
    }
  }
});

// ---------- init ----------
async function init() {
  // Route pty output to terminals (registered once, before any session starts).
  api.onData(({ ptyId, data }) => {
    const sessionId = ptyToSession.get(ptyId);
    if (sessionId) terminals.get(sessionId)?.term.write(data);
  });
  api.onExit(({ ptyId }) => {
    const sessionId = ptyToSession.get(ptyId);
    const entry = sessionId && terminals.get(sessionId);
    if (entry) entry.term.write('\r\n\x1b[90m[process exited — reopen to restart]\x1b[0m\r\n');
  });

  try {
    hostname = (await api.hostInfo()).hostname || '';
  } catch {
    /* non-fatal */
  }

  const loaded = await api.loadState();
  if (loaded && Array.isArray(loaded.repos)) state = loaded;
  liveSlugs = new Set(await api.listSessions());
  render();
}

init();
