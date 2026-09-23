/* NetLab — мост между страницей и настольной оболочкой. Странице доступны только эти функции. */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('netlabDesktop', {
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch (e) { return null; }
  },
  setState: (s) => ipcRenderer.send('app:state', s),
  closeNow: () => ipcRenderer.send('app:close-now'),
  version: () => ipcRenderer.invoke('app:version'),
  releaseNotes: () => ipcRenderer.invoke('app:release-notes'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onOpenFile: (cb) => ipcRenderer.on('file:opened', (_e, f) => cb(f)),
  // обновления
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkUpdates: (opts) => ipcRenderer.invoke('update:check', opts || {}),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  openUpdatePage: () => ipcRenderer.invoke('update:open-page'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:event', (_e, ev) => cb(ev)),
});
