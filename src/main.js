'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell: electronShell } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const state = require('./state');
const shell = require('./shell');
const snap = require('./snapshot');
const store = require('./snapshot-store');
const { createWorkTracker } = require('./work-tracker');

// Keep dev (`npm start`) and the packaged .app pointed at the same state/config.
// VIBEDECK_USER_DATA points a dev/test run at a throwaway state dir instead.
app.setPath('userData', process.env.VIBEDECK_USER_DATA || path.join(app.getPath('appData'), 'vibedeck'));

let mainWindow = null;

// ptyId -> { proc, slug }. ptyId identifies a live shell for this app run; slug
// is the app's durable session id (its layout persists in state; the shell
// doesn't survive a restart).
const ptys = new Map();
let sessionUpdateWatcher = null;

function userDataDir() {
  return app.getPath('userData');
}

function sessionUpdatesDir() {
  return path.join(userDataDir(), 'session-updates');
}

function agentRegistryDir() {
  return store.agentRegistryDir(userDataDir());
}

// Local, uncommitted configuration (ticket trackers): $VIBEDECK_CONFIG_DIR, else
// the repo's gitignored local/ when run from source (`npm start`), else
// <userData>/local for the installed app (install-app.sh symlinks it to the
// repo's local/). See examples/local/.
function localConfigDir() {
  if (process.env.VIBEDECK_CONFIG_DIR) return process.env.VIBEDECK_CONFIG_DIR;
  if (!app.isPackaged) return path.join(app.getAppPath(), 'local');
  return path.join(userDataDir(), 'local');
}

// ---- session work tracking (tickets + PRs per tab; see work-tracker.js) ----
let workTracker = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---- session snapshots (which agent conversation runs in which tab) ----

const DAILY_CHECK_INTERVAL_MS = 15 * 60 * 1000;
let dailySnapshotTimer = null;
let quitSnapshotTaken = false;

// [{ slug, pid }] for every tab whose shell is alive in this app run.
function liveShells() {
  return [...ptys.values()].map(({ slug, proc }) => ({ slug, pid: proc.pid })).filter((s) => s.pid);
}

function safeTakeSnapshot(trigger) {
  try {
    return store.takeSnapshot(userDataDir(), liveShells(), trigger);
  } catch (error) {
    console.error(`[vibedeck] ${trigger} snapshot failed:`, error);
    return { saved: false, trigger, error: String(error?.message || error) };
  }
}

// Once per local calendar day. Retries every interval until a day's snapshot
// lands (e.g. when nothing was running yet at the first check).
function maybeTakeDailySnapshot() {
  if (!snap.hasDailyFor(store.listSnapshotNames(userDataDir()))) safeTakeSnapshot('daily');
}

function startDailySnapshots() {
  setTimeout(maybeTakeDailySnapshot, 2 * 60 * 1000); // let restored agents start first
  dailySnapshotTimer = setInterval(maybeTakeDailySnapshot, DAILY_CHECK_INTERVAL_MS);
}

// Scan registered parent folders one level deep for git repositories.
function scanRepos(parentFolders) {
  const out = [];
  const seen = new Set();
  for (const parent of Array.isArray(parentFolders) ? parentFolders : []) {
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue; // unreadable / removed folder
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(parent, ent.name);
      try {
        fs.accessSync(path.join(full, '.git'));
      } catch {
        continue; // not a git repo
      }
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ name: ent.name, path: full, parent });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0e0f13',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // App keyboard shortcuts, handled before the page so Chromium/xterm can't
  // claim them (⌘P, ⌘T, ⌘1-9, ⌘⌥ arrows, ⌘⇧[ ]). Dispatched to the renderer
  // via the same "menu-action" channel the menu items use.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    let action = null;
    if (
      input.shift &&
      !input.meta &&
      !input.control &&
      !input.alt &&
      (input.key === 'Enter' || input.code === 'Enter' || input.code === 'NumpadEnter')
    ) {
      action = 'newline'; // Shift+Enter — insert a newline instead of submitting
    } else if (input.control && input.shift && input.code === 'Backquote') {
      action = 'new-session'; // Ctrl+Shift+` — new session (VS Code style)
    } else if (input.meta && input.shift) {
      // brackets = horizontal (scopes); ' \ = vertical (sessions)
      if ((input.key || '').toLowerCase() === 'p') action = 'command-palette';
      else if (input.code === 'BracketLeft') action = 'prev-scope';
      else if (input.code === 'BracketRight') action = 'next-scope';
      else if (input.code === 'Quote') action = 'prev-session';
      else if (input.code === 'Backslash') action = 'next-session';
    } else if (input.meta) {
      const k = (input.key || '').toLowerCase();
      if (k === 'p') action = 'palette';
      else if (k === 't') action = 'new-session';
      else if (k === 'w') action = 'close-session';
      else if (/^[1-9]$/.test(input.key)) action = `session:${input.key}`;
    }
    if (action) {
      event.preventDefault();
      sendMenu(action);
    }
  });
}

function sendMenu(action) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu-action', action);
  }
}

function shellIntegrationScript() {
  // Emit OSC 7 (current directory) on each prompt so the renderer can track the
  // session's real cwd/worktree without modifying user dotfiles.
  return [
    '__vibedeck_emit_cwd() {',
    '  printf \'\\033]7;file://%s%s\\007\' "$(hostname 2>/dev/null || printf localhost)" "$PWD"',
    '}',
    'if [ -n "${ZSH_VERSION-}" ]; then',
    '  autoload -Uz add-zsh-hook 2>/dev/null || true',
    '  if command -v add-zsh-hook >/dev/null 2>&1; then',
    '    add-zsh-hook precmd __vibedeck_emit_cwd 2>/dev/null || true',
    '  else',
    '    case " ${precmd_functions[*]-} " in',
    '      *" __vibedeck_emit_cwd "*) ;;',
    '      *) precmd_functions+=(__vibedeck_emit_cwd) ;;',
    '    esac',
    '  fi',
    'elif [ -n "${BASH_VERSION-}" ]; then',
    '  case ";${PROMPT_COMMAND-};" in',
    '    *";__vibedeck_emit_cwd;"*) ;;',
    '    *) PROMPT_COMMAND="__vibedeck_emit_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;',
    '  esac',
    'fi',
    '__vibedeck_emit_cwd',
  ].join('\n');
}

// After a session's shell settles at its first prompt (output goes quiet), cd it
// into the repo. `builtin cd` bypasses shell `cd` wrappers (e.g. RVM's), and
// waiting for quiet avoids racing shell startup.
function scheduleInitialCd(proc, dir, initialCommand) {
  const quoted = `'${String(dir).replace(/'/g, `'\\''`)}'`;
  let timer = null;
  let done = false;
  const sub = proc.onData(() => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      done = true;
      try {
        const then = initialCommand ? ` && ${initialCommand}` : '';
        proc.write(`${shellIntegrationScript()}\rbuiltin cd -- ${quoted} && clear${then}\r`);
      } catch {
        /* pty gone */
      }
      try {
        sub.dispose();
      } catch {
        /* noop */
      }
    }, 700);
  });
}

// A native menu owns the app shortcuts. Menu accelerators are handled before
// the web contents, so keys Chromium would otherwise claim (⌘P, ⌘T, ⌘1-9,
// ⌘⌥ arrows) reliably reach the app even when the terminal is focused.
function buildMenu() {
  const item = (label, accelerator, action) => ({
    label,
    accelerator,
    registerAccelerator: false, // show the shortcut, but let before-input-event own it
    click: () => sendMenu(action),
  });
  const jump = [];
  for (let i = 1; i <= 9; i++) jump.push(item(`Session ${i}`, `Cmd+${i}`, `session:${i}`));

  const template = [
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendMenu('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendMenu('paste') },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendMenu('select-all') },
      ],
    },
    {
      label: 'Go',
      submenu: [
        item('Open Repo Palette', 'Cmd+P', 'palette'),
        item('Command Palette', 'Cmd+Shift+P', 'command-palette'),
        item('New Session', 'Cmd+T', 'new-session'),
        item('Close Active Session', 'Cmd+W', 'close-session'),
        { type: 'separator' },
        item('Save Session Snapshot', undefined, 'snapshot-save'),
        item('Restore Latest Snapshot…', undefined, 'snapshot-restore-latest'),
        { type: 'separator' },
        item('Previous Scope', 'Cmd+Shift+[', 'prev-scope'),
        item('Next Scope', 'Cmd+Shift+]', 'next-scope'),
        item('Previous Session', "Cmd+Shift+'", 'prev-session'),
        item('Next Session', 'Cmd+Shift+\\', 'next-session'),
        { type: 'separator' },
        { label: 'Jump to Session', submenu: jump },
      ],
    },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createWindow();
  buildMenu();
  workTracker = createWorkTracker({
    configDir: localConfigDir(),
    registryDir: agentRegistryDir(),
    liveShells,
    send: sendToRenderer,
    env: shell.toolEnv(),
  });
  workTracker.start();
  startSessionUpdateWatcher();
  startDailySnapshots();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Kill every session's shell on quit — nothing persists past the app.
app.on('before-quit', () => {
  // Snapshot before the shells (and their agents) are killed below.
  if (!quitSnapshotTaken) {
    quitSnapshotTaken = true;
    safeTakeSnapshot('quit');
  }
  if (dailySnapshotTimer) clearInterval(dailySnapshotTimer);
  workTracker?.stop();
  try {
    sessionUpdateWatcher?.close();
  } catch {
    /* noop */
  }
  for (const { proc } of ptys.values()) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
});

function readSessionUpdate(fileName) {
  if (!fileName || !fileName.endsWith('.json')) return;
  const file = path.join(sessionUpdatesDir(), fileName);
  setTimeout(() => {
    let update;
    try {
      update = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    // `vibedeck-attach` drops { slug, attach: ["<ticket id>" | "<PR URL>", …] }.
    if (update && typeof update.slug === 'string' && Array.isArray(update.attach) && workTracker) {
      const refs = update.attach.map((text) => workTracker.parseRef(String(text))).filter(Boolean);
      const tickets = refs.filter((r) => r.kind === 'ticket').map((r) => r.key);
      const prs = refs.filter((r) => r.kind === 'pr').map((r) => r.url);
      if (tickets.length || prs.length) sendToRenderer('work:refs', { slug: update.slug, tickets, prs, manual: true });
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort cleanup */
    }
  }, 50);
}

function startSessionUpdateWatcher() {
  const dir = sessionUpdatesDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    sessionUpdateWatcher = fs.watch(dir, (_event, fileName) => readSessionUpdate(fileName));
  } catch {
    sessionUpdateWatcher = null;
  }
  try {
    for (const fileName of fs.readdirSync(dir)) readSessionUpdate(fileName);
  } catch {
    /* noop */
  }
}

// ---- app info ----
ipcMain.handle('app:info', () => ({ hostname: os.hostname(), homedir: os.homedir() }));

// ---- clipboard (xterm manages its own selection, so we copy/paste explicitly) ----
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});
ipcMain.handle('clipboard:read', () => clipboard.readText());

// Open terminal links in the user's default browser. Only allow web URLs; terminal
// output is untrusted and must not be able to launch arbitrary app protocols.
ipcMain.handle('shell:openExternalUrl', async (_e, rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  await electronShell.openExternal(url.toString());
  return true;
});

// If the clipboard holds an image, stash it as a temp PNG and return the path so
// the renderer can type it into the terminal — Claude Code / pi read an image
// path from the prompt, the same way a drag-and-drop works. Returns null when
// there's no image (the renderer then falls back to a normal text paste).
ipcMain.handle('clipboard:readImage', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  try {
    const dir = path.join(os.tmpdir(), 'vibedeck-paste');
    fs.mkdirSync(dir, { recursive: true });
    // Best-effort prune of pastes older than a day so the dir doesn't grow.
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch {
      /* pruning is best-effort */
    }
    const file = path.join(dir, `img-${crypto.randomUUID()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch {
    return null; // fall back to text paste
  }
});

// ---- state ----
ipcMain.handle('state:load', () => state.loadState(userDataDir()));
ipcMain.handle('state:save', (_e, s) => {
  state.saveState(userDataDir(), s);
  return true;
});

// ---- folder picker ----
ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  return { path: p, name: path.basename(p) };
});

// ---- live-session reconciliation on launch (always empty: nothing persists) ----
ipcMain.handle('sessions:live', () => shell.listSessions());

// ---- repo discovery under registered parent folders ----
ipcMain.handle('repos:scan', (_e, parentFolders) => scanRepos(parentFolders));

// ---- session work tracking ----
ipcMain.handle('work:sync', (_e, sessions) => workTracker?.sync(sessions));
ipcMain.handle('work:refresh', () => workTracker?.refresh({ force: true }));
ipcMain.handle('work:snapshot', () => workTracker?.snapshot() || null);
ipcMain.handle('work:parseRef', (_e, text) => workTracker?.parseRef(String(text || '')) || null);

// ---- sessions ----
// ---- snapshots ----
ipcMain.handle('snapshot:save', () => safeTakeSnapshot('manual'));
ipcMain.handle('snapshot:list', () => store.snapshotSummaries(userDataDir()));
ipcMain.handle('snapshot:plan', (_e, name) => store.planSnapshotRestore(userDataDir(), liveShells(), name));

ipcMain.handle('session:start', (_e, { slug, cwd, cols, rows, initialCommand }) => {
  const { proc, isNew, startDir } = shell.spawnSession({
    slug,
    cwd,
    cols,
    rows,
    updatesDir: sessionUpdatesDir(),
    agentsDir: agentRegistryDir(),
  });
  const ptyId = crypto.randomUUID();
  ptys.set(ptyId, { proc, slug });

  proc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session:data', { ptyId, data });
    }
  });
  proc.onExit(() => {
    ptys.delete(ptyId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('session:exit', { ptyId });
    }
  });

  // Some shells cd on startup (RVM/oh-my-zsh here), overriding the pty's cwd.
  // Once the shell settles at its first prompt, cd into the repo.
  // initialCommand (snapshot restore) runs right after that cd.
  if (isNew) scheduleInitialCd(proc, startDir, typeof initialCommand === 'string' ? initialCommand : null);

  return { ptyId };
});

ipcMain.on('session:write', (_e, { ptyId, data }) => {
  const entry = ptys.get(ptyId);
  if (entry) {
    try {
      entry.proc.write(data);
    } catch {
      /* pty gone */
    }
  }
});

ipcMain.on('session:resize', (_e, { ptyId, cols, rows }) => {
  const entry = ptys.get(ptyId);
  if (entry && cols > 0 && rows > 0) {
    try {
      entry.proc.resize(cols, rows);
    } catch {
      /* pty gone */
    }
  }
});

// Destroy a session: kill its shell.
ipcMain.handle('session:kill', (_e, { ptyId }) => {
  if (ptyId && ptys.has(ptyId)) {
    try {
      ptys.get(ptyId).proc.kill();
    } catch {
      /* already gone */
    }
    ptys.delete(ptyId);
  }
  return true;
});
