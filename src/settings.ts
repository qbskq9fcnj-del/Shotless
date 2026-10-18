import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// 保存するのは設定だけ。スクリーンショット画像は絶対に書き込まない。

export interface Settings {
  shortcut: string;
  autoOnSwitch: boolean;
  targets: string[];
  launchAtLogin: boolean;
}

export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+S';

export function defaultSettings(): Settings {
  return {
    shortcut: DEFAULT_SHORTCUT,
    autoOnSwitch: false,
    targets: ['Claude'],
    launchAtLogin: false,
  };
}

export function sanitizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  return {
    shortcut:
      typeof r.shortcut === 'string' && r.shortcut.trim() ? r.shortcut.trim() : base.shortcut,
    autoOnSwitch: typeof r.autoOnSwitch === 'boolean' ? r.autoOnSwitch : base.autoOnSwitch,
    targets: Array.isArray(r.targets)
      ? r.targets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20)
      : base.targets,
    launchAtLogin: typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : base.launchAtLogin,
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
