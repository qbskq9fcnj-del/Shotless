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
import { loadSettings, sanitizeSettings, saveSettings, Settings } from './settings';

// 注意: 撮影した画像はメモリ上の nativeImage のまま扱い、ディスクには一切書き込まない。
// 保存するのは settings.ts の設定ファイルだけ。

const FLASH_MS = 400;

let settings: Settings;
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let capturing = false;
let lastCaptureAt = 0;

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

// ショートカットで撮影する。クリップボードに入れ、音とフラッシュで知らせる。
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
    return false; // 不正なアクセラレータ
  }
}

function applyLoginItem(): void {
  if (!app.isPackaged) return; // 開発中(npm start)は登録しない
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
}

function buildTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Shotless', enabled: false },
      { type: 'separator' },
      { label: '設定…', click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: '終了', click: () => app.quit() },
    ]),
  );
  tray?.setToolTip(`Shotless (${settings.shortcut})`);
}

type UpdateResult = { ok: true; settings: Settings } | { ok: false; error: string; settings: Settings };

function updateSettings(patch: unknown): UpdateResult {
  const next = sanitizeSettings({ ...settings, ...(typeof patch === 'object' && patch ? patch : {}) });

  if (next.shortcut !== settings.shortcut) {
    globalShortcut.unregister(settings.shortcut);
    if (!registerShortcut(next.shortcut)) {
      registerShortcut(settings.shortcut); // 失敗したら元のキーに戻す
      return {
        ok: false,
        error: 'このキーは登録できませんでした(他のアプリが使っている可能性があります)',
        settings,
      };
    }
  }

  settings = next;
  saveSettings(settings);
  applyLoginItem();
  buildTrayMenu();
  settingsWindow?.webContents.send('settings:changed', settings);
  return { ok: true, settings };
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 520,
    height: 380,
    title: 'Shotless 設定',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.removeMenu();
  settingsWindow.loadFile(path.join(__dirname, '..', 'src', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  app.focus({ steal: true });
}

function setupTray(): void {
  tray = new Tray(createTrayIcon());
  tray.on('double-click', () => openSettingsWindow());
  buildTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openSettingsWindow());

  app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide();
    settings = loadSettings();

    ipcMain.handle('settings:get', () => settings);
    ipcMain.handle('settings:set', (_event, patch) => updateSettings(patch));

    setupTray();
    if (!registerShortcut(settings.shortcut)) {
      console.error(`failed to register shortcut: ${settings.shortcut}`);
    }
    applyLoginItem();
  });

  // ウィンドウを持たない常駐アプリなので、全ウィンドウが閉じても終了しない
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
