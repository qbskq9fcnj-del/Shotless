import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shotlessOverlay', {
  onCaptureStart: (callback: () => void) => {
    ipcRenderer.on('overlay:capture-start', () => callback());
  },
});
