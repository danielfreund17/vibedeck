'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
}

app.whenReady().then(async () => {
  await tmux.initServer(userDataDir());
  createWindow();
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
