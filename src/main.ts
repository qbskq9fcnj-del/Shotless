import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  Display,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import * as path from 'path';
import { loadSettings, sanitizeSettings, saveSettings, Settings } from './settings';

// 注意: 撮影した画像はメモリ上の nativeImage として扱い、そのままクリップボードに入れる。
// ファイルは作らない。保存するのは settings.ts の設定ファイルだけ。

const FLASH_MS = 400;

let settings: Settings;
let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let overlayWin: BrowserWindow | null = null;
let overlayReady = false;
let overlayPendingStart = false;
let overlayHideTimer: NodeJS.Timeout | null = null;

// 点と線分 (ax,ay)-(bx,by) の距離(線分の端にクランプした射影点との距離)
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

// 点と4分円弧(中心 cx,cy・半径 r・角度 a0〜a1 度)の距離
function distToArc(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
): number {
  const dx = px - cx;
  const dy = py - cy;
  const deg = (((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360;
  if (deg >= a0 && deg <= a1) return Math.abs(Math.hypot(dx, dy) - r);
  const rad0 = (a0 * Math.PI) / 180;
  const rad1 = (a1 * Math.PI) / 180;
  const d0 = Math.hypot(px - (cx + r * Math.cos(rad0)), py - (cy + r * Math.sin(rad0)));
  const d1 = Math.hypot(px - (cx + r * Math.cos(rad1)), py - (cy + r * Math.sin(rad1)));
  return Math.min(d0, d1);
}

// 左上の角の形(線分2本＋円弧)から点までの距離
function distToCorner(x: number, y: number): number {
  return Math.min(
    distToSegment(x, y, 3, 6.5, 3, 5),
    distToSegment(x, y, 5, 3, 6.5, 3),
    distToArc(x, y, 5, 5, 2, 180, 270),
  );
}

function createTrayIcon(): Electron.NativeImage {
  // 18x18 単位の絵を 2 倍(36x36)で生成(画像ファイル不要)
  const size = 36;
  const unit = 18;
  const buf = Buffer.alloc(size * size * 4);
  const corners: [boolean, boolean][] = [
    [false, false], // 左上
    [true, false], // 右上
    [false, true], // 左下
    [true, true], // 右下
  ];
  const LINE_HALF = 0.8; // 線の太さ 1.6 の半分
  const DOT_R = 2.4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 4×4 のサブサンプルで、絵に入った割合を透明度にする
      let hit = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const x = (px + (sx + 0.5) / 4) / 2;
          const y = (py + (sy + 0.5) / 4) / 2;
          const inCorner = corners.some(([flipX, flipY]) => {
            const cx = flipX ? unit - x : x;
            const cy = flipY ? unit - y : y;
            return distToCorner(cx, cy) <= LINE_HALF;
          });
          const inDot = Math.hypot(x - 9, y - 9) <= DOT_R;
          if (inCorner || inDot) hit++;
        }
      }
      const i = (py * size + px) * 4;
      buf[i] = 0; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = Math.round((hit / 16) * 255); // A
    }
  }
  const icon = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
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
  if (sources.length === 0) {
    console.error('capture: no sources');
    return null;
  }
  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    sources[screen.getAllDisplays().findIndex((d) => d.id === display.id)] ??
    sources[0];
  if (!source) return null;
  if (source.thumbnail.isEmpty()) {
    console.error('capture: empty thumbnail');
    return null;
  }
  return source.thumbnail;
}

// フラッシュと音を出す、全面の透明ウィンドウ。起動時に1枚だけ作って隠しておく。
function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: primary.bounds.width,
    height: primary.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'overlayPreload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.setContentProtection(true);
  win.webContents.once('did-finish-load', () => {
    overlayReady = true;
    if (overlayPendingStart) {
      overlayPendingStart = false;
      win.webContents.send('overlay:capture-start');
    }
  });
  win.on('closed', () => {
    overlayWin = null;
    overlayReady = false;
    overlayPendingStart = false;
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'overlay.html'));
  overlayWin = win;
  return win;
}

// 押された瞬間に、その画面へフラッシュを出して音を鳴らす。
function showFlash(display: Display): void {
  let win = overlayWin;
  if (!win || win.isDestroyed()) win = createOverlayWindow();
  // macOS が作業領域に押し込むのを避け、メニューバーと Dock まで覆う
  win.setBounds(display.bounds);
  win.showInactive();
  if (overlayReady) {
    win.webContents.send('overlay:capture-start');
  } else {
    overlayPendingStart = true; // 読み込み完了後に送る
  }
  if (overlayHideTimer) clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => {
    overlayHideTimer = null;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  }, FLASH_MS);
}

// 撮影は押された順に1つずつ処理する(連続で押されても捨てない)。
let queue: Promise<void> = Promise.resolve();

// 撮影に失敗したときの案内。毎回出すが、連続では出さないよう数秒あける。
const FAILURE_NOTICE_GAP_MS = 4000;
let lastFailureNoticeAt = 0;

function handleCaptureFailure(): void {
  const now = Date.now();
  if (now - lastFailureNoticeAt < FAILURE_NOTICE_GAP_MS) return;
  lastFailureNoticeAt = now;
  // 案内の前に、残っているフラッシュの窓を隠す
  if (overlayHideTimer) {
    clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    dialog
      .showMessageBox({
        type: 'warning',
        message: '画面収録の許可が必要です',
        detail:
          'システム設定の「画面とシステムオーディオの録音」で、Shotless(開発中は Electron)を許可して、アプリを再起動してください。',
        buttons: ['システム設定を開く', '閉じる'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        }
      })
      .catch(() => {});
    return;
  }
  dialog
    .showMessageBox({
      type: 'warning',
      message: '撮影できませんでした',
      detail: 'もう一度試してください。',
      buttons: ['閉じる'],
    })
    .catch(() => {});
}

async function doCapture(display: Display): Promise<void> {
  try {
    const start = app.isPackaged ? 0 : Date.now();
    let image = await captureDisplay(display);
    if (!image) {
      // 起動直後の初回だけ空になることがあるため、少し待って1回だけやり直す
      await new Promise((resolve) => setTimeout(resolve, 200));
      image = await captureDisplay(display);
      if (image && !app.isPackaged) console.log('capture: retried');
    }
    if (!image) {
      handleCaptureFailure();
      return;
    }
    if (!app.isPackaged) {
      const size = image.getSize();
      console.log(`capture size: ${size.width}x${size.height}`);
      console.log('capture ms: ' + (Date.now() - start));
    }
    clipboard.writeImage(image);
  } catch (err) {
    console.error('capture failed:', err);
  }
}

function registerShortcut(accelerator: string): boolean {
  try {
    return globalShortcut.register(accelerator, () => {
      const display = currentDisplay();
      showFlash(display);
      queue = queue.then(() => doCapture(display));
    });
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

    if (!app.isPackaged && process.platform === 'darwin') {
      console.log('screen access: ' + systemPreferences.getMediaAccessStatus('screen'));
    }
    setupTray();
    createOverlayWindow();
    // 初回の撮影が空になるのを避けるため、起動時に撮影の準備だけ済ませる
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    if (!registerShortcut(settings.shortcut)) {
      console.error(`failed to register shortcut: ${settings.shortcut}`);
    }
    applyLoginItem();
  });

  // ウィンドウを持たない常駐アプリなので、全ウィンドウが閉じても終了しない
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}
