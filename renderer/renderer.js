'use strict';

/* globals Terminal, FitAddon */

// VibeDeck renderer. Owns the scope -> session model, renders the two-axis UI,
// and lazily attaches an xterm <-> pty <-> tmux pipe per session on demand.

const api = window.api;

let state = {
  repos: [],
  activeRepoId: null,
  activeSessionByRepo: {},
  sidebarWidth: 210,
  parentFolders: [],
};
let liveSlugs = new Set(); // tmux sessions alive on our socket right now
let hostname = ''; // used to ignore tmux's default (hostname) pane title
let homedir = ''; // used to prettify paths (~/...)
let paletteEl = null; // the open command-palette overlay, if any

// sessionId -> { term, fit, ptyId, el }
const terminals = new Map();
// ptyId -> sessionId, to route incoming pty data to the right terminal
const ptyToSession = new Map();

const el = {
  topbar: document.getElementById('topbar'),
  sidebar: document.getElementById('sidebar'),
  terminals: document.getElementById('terminals'),
  empty: document.getElementById('empty'),
  resizer: document.getElementById('resizer'),
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
function activeEntry() {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  return sid ? terminals.get(sid) : null;
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
  return homedir && p.startsWith(homedir) ? '~' + p.slice(homedir.length) : p;
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
    items = !q
      ? paletteRepos.slice()
      : paletteRepos
          .map((r) => ({ r, s: fuzzyScore(r.name.toLowerCase(), q) }))
          .filter((x) => x.s > -Infinity)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.r);
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
    items.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'palette-item' + (i === sel ? ' active' : '');
      const nm = document.createElement('span');
      nm.className = 'pi-name';
      nm.textContent = r.name;
      const pa = document.createElement('span');
      pa.className = 'pi-path';
      pa.textContent = openCwds.has(r.path) ? '• already open' : prettyPath(r.parent);
      row.append(nm, pa);
      row.onmouseenter = () => {
        sel = i;
        highlight();
      };
      row.onclick = () => choose(r);
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

  async function choose(r) {
    close();
    await openRepoScope(r.path, r.name);
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

// Move left (-1) / right (+1) across the scope tabs, wrapping around.
function cycleRepo(dir) {
  if (state.repos.length === 0) return;
  let idx = state.repos.findIndex((r) => r.id === state.activeRepoId);
  if (idx === -1) idx = 0;
  const n = state.repos.length;
  const nextIdx = (idx + dir + n) % n;
  selectRepo(state.repos[nextIdx].id);
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

  const entry = { term, fit, ptyId, el: wrap, slug: session.slug, lastCols: term.cols, lastRows: term.rows };
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
    fitEntry(entry);
    entry.term.focus();
  });
}

// ---------- global events ----------
// Fit a terminal to its container, but only tell the pty when the size actually
// changed. Spurious resizes make inline TUIs (pi, Claude Code) redraw and can
// leave duplicated/scattered output.
// Some inline TUIs (pi) only re-render on SIGWINCH, and xterm's steady-state DOM
// render can lag its buffer once resizing stops — leaving blank/leftover rows.
// After the last resize settles, force a couple of full redraws (scrolling to
// the latest output) so the display matches the buffer, like it does mid-drag.
let refreshTimer = null;
function forceRedraw() {
  const entry = activeEntry();
  if (!entry) return;
  api.redraw(entry.slug); // tmux resends a full clean screen -> xterm resyncs
  try {
    entry.term.scrollToBottom();
  } catch {
    /* noop */
  }
}
function scheduleRedraw() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    forceRedraw();
    setTimeout(forceRedraw, 250); // catch a late TUI redraw after SIGWINCH
  }, 150);
}

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
  scheduleRedraw();
}

// Refit the visible terminal.
function fitActive() {
  const repo = activeRepo();
  const sid = repo ? activeSessionId(repo.id) : null;
  fitEntry(sid ? terminals.get(sid) : null);
}

window.addEventListener('resize', fitActive);

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

  // Shortcuts routed from the native menu (main process).
  api.onMenu(async (action) => {
    if (paletteEl && action !== 'palette') return;
    const repo = activeRepo();
    if (action === 'palette') openPalette();
    else if (action === 'new-session') {
      if (repo) addSession(repo.id);
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
        const text = await api.clipRead();
        if (text) entry.term.paste(text);
      }
    } else if (action === 'select-all') {
      activeEntry()?.term.selectAll();
    } else if (action === 'newline') {
      const entry = activeEntry();
      if (entry) api.writeSession(entry.ptyId, '\x1b\r');
    } else if (action.startsWith('session:')) {
      const s = repo?.sessions[Number(action.slice(8)) - 1];
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
  liveSlugs = new Set(await api.listSessions());
  applySidebarWidth();
  initResizer();
  render();
}

init();
