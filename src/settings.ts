import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// 保存するのは設定だけ。スクリーンショット画像は絶対に書き込まない。

export interface Settings {
  shortcut: string;
  launchAtLogin: boolean;
  // 連続撮影を防ぐ最小間隔(ミリ秒)。自動撮影ではない。
  intervalMs: number;
}

export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+S';

export function defaultSettings(): Settings {
  return { shortcut: DEFAULT_SHORTCUT, launchAtLogin: false, intervalMs: 1000 };
}

export function sanitizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  return {
    shortcut:
      typeof r.shortcut === 'string' && r.shortcut.trim() ? r.shortcut.trim() : base.shortcut,
    launchAtLogin: typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : base.launchAtLogin,
    intervalMs:
      typeof r.intervalMs === 'number' && Number.isFinite(r.intervalMs)
        ? Math.min(10000, Math.max(0, Math.round(r.intervalMs)))
        : base.intervalMs,
  };
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('failed to save settings:', err);
  }
}
