import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// 保存するのは設定の JSON だけ。撮影した画像は一切書き込まない。

export interface Settings {
  shortcut: string;
  // 連続撮影を防ぐための最小間隔(ミリ秒)。自動撮影ではない。
  intervalMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  shortcut: 'CommandOrControl+Shift+S',
  intervalMs: 1000,
};

export const MIN_INTERVAL_MS = 0;
export const MAX_INTERVAL_MS = 10000;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function sanitize(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Settings>;
  const shortcut =
    typeof raw.shortcut === 'string' && raw.shortcut.trim()
      ? raw.shortcut.trim()
      : DEFAULT_SETTINGS.shortcut;
  const n = Number(raw.intervalMs);
  const intervalMs = Number.isFinite(n)
    ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)))
    : DEFAULT_SETTINGS.intervalMs;
  return { shortcut, intervalMs };
}

export function loadSettings(): Settings {
  try {
    return sanitize(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}
