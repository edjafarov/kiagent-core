/**
 * @jest-environment node
 *
 * fast-glob's async walker (via `countFiles`) uses `setImmediate`, which jsdom
 * does not provide — same fix as local-folder-source.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LOCAL_FOLDER_PICKER_MODES,
  folderPickerSpec,
  selectionNodes,
} from '../picker';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-folder-picker-'));
}

describe('folderPickerSpec', () => {
  it('keeps the two shipped local-filesystem tabs, in order', () => {
    // Byte-for-byte FolderPickerModal.tsx:61-64's LOCAL_FS_MODES. That
    // built-in fallback goes away with the `folder-paths` prompt (Task 9);
    // these labels must survive the move or the Add screen visibly changes.
    expect(LOCAL_FOLDER_PICKER_MODES).toEqual([
      { key: 'quick', label: 'Quick links' },
      { key: 'drives', label: 'Browse from drive root…' },
    ]);
  });

  it('carries multiSelect, selected and purpose onto the spec', () => {
    const spec = folderPickerSpec({
      selected: [{ id: '/tmp/a', name: 'a', hasChildren: true }],
      purpose: 'manage',
    });
    expect(spec.modes).toEqual(LOCAL_FOLDER_PICKER_MODES);
    expect(spec.multiSelect).toBe(true);
    expect(spec.purpose).toBe('manage');
    expect(spec.selected).toEqual([
      { id: '/tmp/a', name: 'a', hasChildren: true },
    ]);
  });

  it('lists child folders as nodes whose id is the absolute path', async () => {
    const dir = mkTmpDir();
    fs.mkdirSync(path.join(dir, 'b'));
    fs.mkdirSync(path.join(dir, 'a', 'deep'), { recursive: true });
    const spec = folderPickerSpec({ selected: [], purpose: 'connect' });
    expect(await spec.children(dir)).toEqual([
      { id: path.join(dir, 'a'), name: 'a', hasChildren: true },
      { id: path.join(dir, 'b'), name: 'b', hasChildren: false },
    ]);
  });

  it('counts only files the scanner would index, and returns null for a non-directory', async () => {
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi');
    fs.writeFileSync(path.join(dir, 'backup.zip'), 'x');
    const spec = folderPickerSpec({ selected: [], purpose: 'connect' });
    expect(await spec.count!(dir)).toEqual({ count: 1, capped: false });
    expect(await spec.count!(path.join(dir, 'notes.txt'))).toBeNull();
    expect(await spec.count!(path.join(dir, 'nope'))).toBeNull();
  });

  it('roots("quick") yields absolute ids; roots("drives") includes the filesystem root', async () => {
    const spec = folderPickerSpec({ selected: [], purpose: 'connect' });
    const quick = await spec.roots('quick');
    expect(quick.every((n) => path.isAbsolute(n.id))).toBe(true);
    const drives = await spec.roots('drives');
    expect(drives.some((n) => n.id === path.parse(process.cwd()).root)).toBe(
      true,
    );
  });
});

describe('selectionNodes', () => {
  it('probes hasChildren and still lists a vanished root', async () => {
    // Removing a root that no longer exists on disk is the main reason to
    // open Manage folders — it must never disappear from the chip tray.
    const dir = mkTmpDir();
    fs.mkdirSync(path.join(dir, 'child'));
    const gone = path.join(dir, 'gone');
    expect(
      await selectionNodes([
        { id: dir, name: path.basename(dir) },
        { id: gone, name: 'gone' },
      ]),
    ).toEqual([
      { id: dir, name: path.basename(dir), hasChildren: true },
      { id: gone, name: 'gone', hasChildren: false },
    ]);
  });
});
