/**
 * In-app folder-tree browsing for the folder picker (see
 * @renderer/components/folder-picker/FolderPickerModal). Ported from
 * kiagent-ref src/main/connectors/local-folder/tree.ts — `countLocalFiles`
 * is NOT ported here, since this repo already has an equivalent
 * (scanner.ts's `countFiles`, exposed over `sources:count-files`) that both
 * the tree rows and the under-field count line reuse.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface LocalFolderEntry {
  path: string;
  name: string;
  hasChildren: boolean;
}

async function hasSubdir(absPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(absPath, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    return false;
  }
}

/** Immediate subdirectories of `absPath`, sorted, hidden + files excluded.
 *  Returns [] (never throws) when the directory can't be read. */
export async function listChildren(
  absPath: string,
): Promise<LocalFolderEntry[]> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter(
    (e) => e.isDirectory() && !e.name.startsWith('.'),
  );
  const out: LocalFolderEntry[] = [];
  for (const e of dirs) {
    const child = path.join(absPath, e.name);
    out.push({
      path: child,
      name: e.name,
      hasChildren: await hasSubdir(child),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Curated entry points: the subset of Home/Desktop/Documents/Downloads that
 *  exist as directories. */
export async function quickLinks(): Promise<LocalFolderEntry[]> {
  const home = os.homedir();
  const candidates = [
    { name: 'Home', p: home },
    { name: 'Desktop', p: path.join(home, 'Desktop') },
    { name: 'Documents', p: path.join(home, 'Documents') },
    { name: 'Downloads', p: path.join(home, 'Downloads') },
  ];
  const out: LocalFolderEntry[] = [];
  for (const c of candidates) {
    try {
      if ((await fs.stat(c.p)).isDirectory()) {
        out.push({
          path: c.p,
          name: c.name,
          hasChildren: await hasSubdir(c.p),
        });
      }
    } catch {
      /* skip missing */
    }
  }
  return out;
}

/** Escape hatch — browse from a drive root. Windows: existing drive letters;
 *  macOS: '/' plus /Volumes/*; Linux: '/' plus /media/*. */
export async function listDrives(): Promise<LocalFolderEntry[]> {
  if (process.platform === 'win32') {
    const out: LocalFolderEntry[] = [];
    for (let i = 67; i <= 90; i++) {
      const letter = String.fromCharCode(i); // C..Z
      const root = `${letter}:\\`;
      try {
        await fs.access(root);
        out.push({ path: root, name: `${letter}:`, hasChildren: true });
      } catch {
        /* drive absent */
      }
    }
    return out;
  }
  const out: LocalFolderEntry[] = [{ path: '/', name: '/', hasChildren: true }];
  const volRoot = process.platform === 'darwin' ? '/Volumes' : '/media';
  try {
    const vols = await fs.readdir(volRoot, { withFileTypes: true });
    for (const v of vols) {
      if (v.isDirectory()) {
        const p = path.join(volRoot, v.name);
        out.push({ path: p, name: v.name, hasChildren: await hasSubdir(p) });
      }
    }
  } catch {
    /* no volumes dir */
  }
  return out;
}
