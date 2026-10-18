import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shotless', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (callback: (settings: unknown) => void) => {
    ipcRenderer.on('settings:changed', (_event, settings) => callback(settings));
  },
});
