/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Account } from '@shared/contracts';

import {
  NO_ROOTS_ERROR,
  folderScopedConfig,
  readFolderRoots,
  removedRootIds,
  validateFolderRoots,
} from '../folder-roots';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-folder-roots-'));
}

function acct(config: Record<string, unknown>): Account {
  return {
    id: 'acct-local-folder-1',
    source: 'local-folder',
    identifier: 'this-machine',
    config,
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
}

describe('readFolderRoots', () => {
  it('reads canonical folderRoots', () => {
    expect(
      readFolderRoots(acct({ folderRoots: [{ id: '/tmp/a', name: 'a' }] })),
    ).toEqual([{ id: '/tmp/a', name: 'a' }]);
  });

  it('falls back to the legacy paths mirror, deriving a display name', () => {
    // Reading the mirror is this source's job (a pre-migration account must
    // still sync); WRITING it is core's (A-2).
    // TODO(folder-scope-train-2): delete with the mirror.
    expect(readFolderRoots(acct({ paths: ['/tmp/a'] }))).toEqual([
      { id: '/tmp/a', name: 'a' },
    ]);
  });

  it('prefers folderRoots when both shapes are present', () => {
    // Core writes both: canonical + the mirror it derives. Canonical wins,
    // and a stale mirror can never widen or narrow the real scope.
    expect(
      readFolderRoots(
        acct({
          folderRoots: [{ id: '/tmp/new', name: 'new' }],
          paths: ['/tmp/old'],
        }),
      ),
    ).toEqual([{ id: '/tmp/new', name: 'new' }]);
  });

  it('throws the pinned permanent error for an empty or malformed scope', () => {
    expect(() => readFolderRoots(acct({}))).toThrow(NO_ROOTS_ERROR);
    expect(() => readFolderRoots(acct({ folderRoots: [] }))).toThrow(
      NO_ROOTS_ERROR,
    );
    expect(() =>
      readFolderRoots(acct({ folderRoots: [{ name: 'no id' }] })),
    ).toThrow(NO_ROOTS_ERROR);
  });
});

describe('folderScopedConfig', () => {
  it('writes CANONICAL-ONLY scope and keeps unrelated keys', () => {
    const cfg = folderScopedConfig({ watch: false }, [
      { id: '/tmp/a', name: 'a' },
      { id: '/tmp/b', name: 'b' },
    ]);
    expect(cfg.folderRoots).toEqual([
      { id: '/tmp/a', name: 'a' },
      { id: '/tmp/b', name: 'b' },
    ]);
    // DECISIONS A-2: the legacy `paths` mirror has exactly ONE owner — core,
    // in the v3 migration and in applyFolderScope. This source must not
    // write it. (It must not STRIP it either: see the next test.)
    expect('paths' in cfg).toBe(false);
    // Unrelated keys survive — losing `watch` would silently re-enable the
    // chokidar watcher on an account that opted out.
    expect(cfg.watch).toBe(false);
  });

  it('passes a pre-existing (stale) legacy mirror through untouched', () => {
    // A-2 says the source is SILENT about `paths`, not that it deletes it.
    // The base config of a migrated account already carries the mirror, so
    // what comes back here is the OLD list — deliberately. Core overwrites
    // it from `folderRoots` inside applyFolderScope before anything durable
    // is written, and readFolderRoots above prefers `folderRoots` anyway.
    const cfg = folderScopedConfig({ paths: ['/tmp/old'] }, [
      { id: '/tmp/new', name: 'new' },
    ]);
    expect(cfg.folderRoots).toEqual([{ id: '/tmp/new', name: 'new' }]);
    expect(cfg.paths).toEqual(['/tmp/old']);
  });
});

describe('removedRootIds (DECISIONS R8, local-folder rule)', () => {
  const sel = (id: string) => ({ id, name: path.basename(id) || id });

  it('returns [] when a retained root still covers the removed one', () => {
    // THE case R8 exists for. Narrowing a subfolder out from under a root
    // that is still selected removes exactly zero documents from scope, so
    // archiving anything here would destroy live rows the user kept.
    expect(removedRootIds([sel('/a/sub')], [sel('/a')])).toEqual([]);
  });

  it('returns the ids of roots nothing retained covers', () => {
    expect(
      removedRootIds([sel('/a'), sel('/b')], [sel('/a'), sel('/c')]),
    ).toEqual(['/b']);
  });

  it('archives the parent when the selection narrows to a child of it', () => {
    // Live rows under /a/sub are stamped scope_root_id '/a', so they DO
    // leave scope as attributed. They come back: /a/sub is absent from the
    // pruned cursor, so pull() backfills it, and write-tx's skip test
    // requires `archived_at === null`, so an archived row is always
    // rewritten on re-emit (write-tx.ts:170-176).
    expect(removedRootIds([sel('/a')], [sel('/a/sub')])).toEqual(['/a']);
  });

  it('is separator-aware — a shared string prefix is not containment', () => {
    // Pins that this calls @shared/folder-paths' isUnder rather than
    // startsWith: '/Users/edjafarov' must NOT cover '/Users/ed'.
    expect(
      removedRootIds([sel('/Users/ed')], [sel('/Users/edjafarov')]),
    ).toEqual(['/Users/ed']);
  });
});

describe('validateFolderRoots', () => {
  it('resolves, names and covering-normalizes the picked ids', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const nested = path.join(dirA, 'nested');
    fs.mkdirSync(nested);
    const roots = await validateFolderRoots([dirA, dirB, nested]);
    expect(roots.map((r) => r.id).sort()).toEqual(
      [path.resolve(dirA), path.resolve(dirB)].sort(),
    );
    expect(roots.every((r) => r.name === path.basename(r.id))).toBe(true);
  });

  it('names a drive root by its own path, never an empty string', async () => {
    const fsRoot = path.parse(process.cwd()).root;
    const roots = await validateFolderRoots([fsRoot]);
    expect(roots[0].name).toBe(roots[0].id);
    expect(roots[0].name.length).toBeGreaterThan(0);
  });

  it('rejects an empty selection, a missing path and a file', async () => {
    await expect(validateFolderRoots([])).rejects.toThrow(
      /folder path is required/,
    );
    await expect(
      validateFolderRoots([
        path.join(os.tmpdir(), 'definitely-does-not-exist-kiagent-xyz'),
      ]),
    ).rejects.toThrow(/does not exist/);
    const dir = mkTmpDir();
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    await expect(validateFolderRoots([file])).rejects.toThrow(
      /not a directory/,
    );
  });
});
