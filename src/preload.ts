import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shotless', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),
});
