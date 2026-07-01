'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const state = require('./state');
const tmux = require('./tmux');

// Keep dev (`npm start`) and the packaged .app pointed at the same state/config.
app.setPath('userData', path.join(app.getPath('appData'), 'vibedeck'));

let mainWindow = null;

// ptyId -> { proc, slug }. ptyId is per-attach (a live client); slug is the
// durable tmux session identity that survives app restarts.
const ptys = new Map();

function userDataDir() {
  return app.getPath('userData');
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
    if (input.type !== 'keyDown' || !input.meta) return;
    let action = null;
    if (input.shift) {
      // brackets = horizontal (scopes); ; ' = vertical (sessions)
      if (input.code === 'BracketLeft') action = 'prev-scope';
      else if (input.code === 'BracketRight') action = 'next-scope';
      else if (input.code === 'Quote') action = 'prev-session';
      else if (input.code === 'Backslash') action = 'next-session';
    } else {
      const k = (input.key || '').toLowerCase();
      if (k === 'p') action = 'palette';
      else if (k === 't') action = 'new-session';
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
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        item('Command Palette', 'Cmd+P', 'palette'),
        item('New Session', 'Cmd+T', 'new-session'),
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
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  await tmux.initServer(userDataDir());
  createWindow();
  buildMenu();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Kill the tmux *clients* on quit; the tmux server (and your shells) live on.
app.on('before-quit', () => {
  for (const { proc } of ptys.values()) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
});

// ---- app info ----
ipcMain.handle('app:info', () => ({ hostname: os.hostname(), homedir: os.homedir() }));

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

// ---- tmux discovery (reconciliation on launch) ----
ipcMain.handle('tmux:listSessions', () => tmux.listSessions());

// ---- repo discovery under registered parent folders ----
ipcMain.handle('repos:scan', (_e, parentFolders) => scanRepos(parentFolders));

// ---- sessions ----
ipcMain.handle('session:start', (_e, { slug, cwd, cols, rows }) => {
  const proc = tmux.spawnSession({ userDataDir: userDataDir(), slug, cwd, cols, rows });
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

// Permanently destroy a session: kill this client, then the tmux session.
ipcMain.handle('session:kill', async (_e, { slug, ptyId }) => {
  if (ptyId && ptys.has(ptyId)) {
    try {
      ptys.get(ptyId).proc.kill();
    } catch {
      /* already gone */
    }
    ptys.delete(ptyId);
  }
  if (slug) await tmux.killSession(slug);
  return true;
});
