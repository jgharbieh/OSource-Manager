import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from './types.js';

export function osourceDir(): string {
  return join(homedir(), '.osource');
}

export function defaultDbPath(): string {
  return join(osourceDir(), 'osm.db');
}

function settingsPath(): string {
  return join(osourceDir(), 'settings.json');
}

/** Load ~/.osource/settings.json, deep-merging stored values over DEFAULT_SETTINGS. Creates the file with defaults if missing. */
export function loadSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) {
    saveSettings(DEFAULT_SETTINGS);
    return structuredClone(DEFAULT_SETTINGS);
  }
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    registerTargets: { ...DEFAULT_SETTINGS.registerTargets, ...stored.registerTargets },
    catalogs: { ...DEFAULT_SETTINGS.catalogs, ...stored.catalogs },
  };
}

export function saveSettings(settings: Settings): void {
  const dir = osourceDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n', 'utf8');
}
