'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only surface the renderer can touch. No Node, no direct pty access.
contextBridge.exposeInMainWorld('api', {
  hostInfo: () => ipcRenderer.invoke('app:info'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (s) => ipcRenderer.invoke('state:save', s),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  listSessions: () => ipcRenderer.invoke('sessions:live'),
  scanRepos: (parents) => ipcRenderer.invoke('repos:scan', parents),
  syncWork: (sessions) => ipcRenderer.invoke('work:sync', sessions),
  refreshWork: () => ipcRenderer.invoke('work:refresh'),
  workSnapshot: () => ipcRenderer.invoke('work:snapshot'),
  parseWorkRef: (text) => ipcRenderer.invoke('work:parseRef', text),
  clipWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  clipRead: () => ipcRenderer.invoke('clipboard:read'),
  clipReadImage: () => ipcRenderer.invoke('clipboard:readImage'),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternalUrl', url),

  saveSnapshot: () => ipcRenderer.invoke('snapshot:save'),
  listSnapshots: () => ipcRenderer.invoke('snapshot:list'),
  planSnapshotRestore: (name) => ipcRenderer.invoke('snapshot:plan', name),

  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  killSession: (slug, ptyId) => ipcRenderer.invoke('session:kill', { slug, ptyId }),
  writeSession: (ptyId, data) => ipcRenderer.send('session:write', { ptyId, data }),
  resizeSession: (ptyId, cols, rows) => ipcRenderer.send('session:resize', { ptyId, cols, rows }),

  onData: (cb) => ipcRenderer.on('session:data', (_e, payload) => cb(payload)),
  onExit: (cb) => ipcRenderer.on('session:exit', (_e, payload) => cb(payload)),
  onWorkRefs: (cb) => ipcRenderer.on('work:refs', (_e, payload) => cb(payload)),
  onWorkTickets: (cb) => ipcRenderer.on('work:tickets', (_e, payload) => cb(payload)),
  onWorkPrs: (cb) => ipcRenderer.on('work:prs', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('menu-action', (_e, action) => cb(action)),
});
