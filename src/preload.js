'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only surface the renderer can touch. No Node, no direct pty access.
contextBridge.exposeInMainWorld('api', {
  hostInfo: () => ipcRenderer.invoke('app:info'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (s) => ipcRenderer.invoke('state:save', s),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  listSessions: () => ipcRenderer.invoke('tmux:listSessions'),
  scanRepos: (parents) => ipcRenderer.invoke('repos:scan', parents),

  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  killSession: (slug, ptyId) => ipcRenderer.invoke('session:kill', { slug, ptyId }),
  writeSession: (ptyId, data) => ipcRenderer.send('session:write', { ptyId, data }),
  resizeSession: (ptyId, cols, rows) => ipcRenderer.send('session:resize', { ptyId, cols, rows }),

  onData: (cb) => ipcRenderer.on('session:data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('session:exit', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('menu-action', (_e, action) => cb(action)),
});
