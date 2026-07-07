/**
 * Disk-state helpers for userData/extensions/ — the installer-owned frozen
 * records (installed.json), the mutable enabled map (state.json, 0o600),
 * and manifest-only discovery. No extension code is ever loaded here.
 */
import fs from 'fs';
import path from 'path';

import type { Manifest } from '@shared/contracts';

import { validateManifestDir } from './manifest';

export interface InstalledRecord {
  id: string;
  version: string;
  ref: string;
  integrity: string | null; // SRI sha512 TOFU pin; null for origin 'dev'
  installedAt: string;
  origin: 'marketplace' | 'dev';
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readInstalled(extDir: string): InstalledRecord[] {
  return readJson<InstalledRecord[]>(path.join(extDir, 'installed.json'), []);
}

export function writeInstalled(
  extDir: string,
  records: InstalledRecord[],
): void {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'installed.json'),
    JSON.stringify(records, null, 2),
  );
}

export function readEnabledState(
  extDir: string,
): Record<string, { enabled: boolean }> {
  return readJson<Record<string, { enabled: boolean }>>(
    path.join(extDir, 'state.json'),
    {},
  );
}

export function writeEnabledState(
  extDir: string,
  state: Record<string, { enabled: boolean }>,
): void {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'state.json'),
    JSON.stringify(state, null, 2),
    {
      mode: 0o600,
    },
  );
}

export interface DiscoveredExtension {
  dirName: string;
  dir: string;
  manifest?: Manifest;
  entryAbsPath?: string;
  error?: string;
}

export function discoverExtensions(extDir: string): DiscoveredExtension[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredExtension[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(extDir, e.name);
    try {
      const { manifest, entryAbsPath } = validateManifestDir(dir);
      out.push({ dirName: e.name, dir, manifest, entryAbsPath });
    } catch (err) {
      out.push({
        dirName: e.name,
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
