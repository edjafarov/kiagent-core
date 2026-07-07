import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listChildren, quickLinks } from '../tree';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-folder-tree-'));
}

function mkdir(dir: string, rel: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

describe('listChildren', () => {
  it('lists immediate subdirectories only, sorted, excluding dotdirs and files', async () => {
    const dir = mkTmpDir();
    mkdir(dir, 'b');
    mkdir(dir, 'a');
    mkdir(dir, 'a/nested');
    mkdir(dir, '.hidden');
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'not a dir');

    const entries = await listChildren(dir);

    expect(entries).toEqual([
      { path: path.join(dir, 'a'), name: 'a', hasChildren: true },
      { path: path.join(dir, 'b'), name: 'b', hasChildren: false },
    ]);
  });

  it('resolves to [] instead of throwing for a nonexistent path', async () => {
    const missing = path.join(os.tmpdir(), 'kiagent-tree-does-not-exist-xyz');

    const entries = await listChildren(missing);

    expect(entries).toEqual([]);
  });
});

describe('quickLinks', () => {
  it('returns only existing curated entry points, including the home dir', async () => {
    const links = quickLinks ? await quickLinks() : [];

    const home = os.homedir();
    const homeEntry = links.find((l) => l.path === home);
    expect(homeEntry).toEqual({ path: home, name: 'Home', hasChildren: expect.any(Boolean) });

    for (const link of links) {
      expect(fs.statSync(link.path).isDirectory()).toBe(true);
    }
    const names = links.map((l) => l.name);
    for (const name of names) {
      expect(['Home', 'Desktop', 'Documents', 'Downloads']).toContain(name);
    }
  });
});
