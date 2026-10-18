import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  Display,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from 'electron';
import * as path from 'path';
import { loadSettings, sanitize, saveSettings, Settings } from './settings';

// 注意: 撮影した画像はメモリ上の nativeImage のまま扱い、ディスクには一切書き込まない。
// 画像の書き込みに fs を使わないこと(settings.ts が設定JSONだけを保存する)。

const FLASH_MS = 400;

let tray: Tray | null = null;
let capturing = false;
let lastCaptureAt = 0;
let settings: Settings;
let settingsWin: BrowserWindow | null = null;

function createTrayIcon(): Electron.NativeImage {
  // 16x16 の単色アイコンをコードで生成(画像ファイル不要)
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const border = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      const center = x >= 6 && x < 10 && y >= 6 && y < 10;
      const on = border || center;
      buf[i] = 0; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = on ? 255 : 0; // A
    }
  }
  const icon = nativeImage.createFromBitmap(buf, { width: size, height: size });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  return icon;
}

function currentDisplay(): Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

async function captureDisplay(display: Display): Promise<Electron.NativeImage | null> {
  const scale = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    },
  });
  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    sources[screen.getAllDisplays().findIndex((d) => d.id === display.id)] ??
    sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  return source.thumbnail;
}

function flashAndBeep(display: Display): void {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, '..', 'src', 'flash.html'));
  win.once('ready-to-show', () => win.showInactive());
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, FLASH_MS);
}

async function takeScreenshot(): Promise<void> {
  if (capturing) return;
  if (Date.now() - lastCaptureAt < settings.intervalMs) return;
  capturing = true;
  try {
    const display = currentDisplay();
    const image = await captureDisplay(display);
    if (!image) return; // 権限がない等。通知は出さない。
    clipboard.writeImage(image);
    lastCaptureAt = Date.now();
    flashAndBeep(display);
  } catch (err) {
    console.error('capture failed:', err);
  } finally {
    capturing = false;
  }
}

function registerShortcut(accelerator: string): boolean {
  try {
    return globalShortcut.register(accelerator, () => void takeScreenshot());
  } catch {
    return false;
  }
}

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 380,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Shotless 設定',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, '..', 'src', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function setupIpc(): void {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_e, input: unknown) => {
    const next = sanitize(input);
    if (next.shortcut !== settings.shortcut) {
      // 新しいショートカットが登録できなければ、元のものを残す
      globalShortcut.unregister(settings.shortcut);
      if (!registerShortcut(next.shortcut)) {
        registerShortcut(settings.shortcut);
        return { ok: false, error: 'このショートカットは使えません' };
      }
    }
    settings = next;
    saveSettings(settings);
    tray?.setToolTip(`Shotless (${settings.shortcut})`);
    return { ok: true, settings };
  });
}

function setupTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(`Shotless (${settings.shortcut})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Shotless', enabled: false },
      { label: '設定...', click: openSettings },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide();
    settings = loadSettings();
    setupTray();
    setupIpc();
    if (!registerShortcut(settings.shortcut)) {
      console.error(`failed to register shortcut: ${settings.shortcut}`);
    }
  });

  // ウィンドウを持たない常駐アプリなので、全ウィンドウが閉じても終了しない
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
