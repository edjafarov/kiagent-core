/** @jest-environment node */
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import type { PathLike, StatOptions } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRootRegistry } from '../file-roots';
import { createScopedFiles } from '../scoped-files';
import type { FileChange } from '@shared/plugin-files';

describe('scoped asynchronous filesystem', () => {
  let outside: string;
  let root: string;
  let registry: ReturnType<typeof createFileRootRegistry>;
  let grant: { id: string };
  let files: ReturnType<typeof createScopedFiles>;
  let movedRoot: string | undefined;

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'kiagent-files-outside-'));
    root = await mkdtemp(join(tmpdir(), 'kiagent-files-root-'));
    registry = createFileRootRegistry();
    grant = await registry.grant('documents', root, {
      name: 'Documents',
      writable: true,
    });
    files = createScopedFiles({
      owner: 'documents',
      roots: registry,
      emit: () => undefined,
      log: () => undefined,
    });
  });

  afterEach(async () => {
    await files.dispose();
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    if (movedRoot) await rm(movedRoot, { recursive: true, force: true });
  });

  it.each([
    '../outside',
    '/absolute',
    'C:\\drive',
    '\\\\server\\share',
    'bad\0name',
  ])('rejects unsafe relative path %s', async (rel) => {
    await expect(files.read({ root: grant.id, rel })).rejects.toThrow();
  });

  it('rejects symlink ancestors that escape the approved root', async () => {
    await symlink(outside, join(root, 'escape'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await expect(
      files.read({ root: grant.id, rel: 'escape/secret.txt' }),
    ).rejects.toThrow();
  });

  it('enforces read-only grants for every mutating operation', async () => {
    await registry.revoke('documents', grant.id);
    grant = await registry.grant('documents', root, {
      name: 'Read only',
      writable: false,
    });
    await expect(
      files.write({ root: grant.id, rel: 'new.txt' }, new Uint8Array([1])),
    ).rejects.toThrow(/read.only|writable/i);
    await expect(
      files.mkdir({ root: grant.id, rel: 'folder' }),
    ).rejects.toThrow();
  });

  it('rejects revoked roots after the service has been created', async () => {
    await registry.revoke('documents', grant.id);
    await expect(files.roots()).resolves.toEqual([]);
    await expect(
      files.read({ root: grant.id, rel: 'missing' }),
    ).rejects.toThrow(/revoked|root/i);
  });

  it('writes and reads with no-replace semantics', async () => {
    const ref = { root: grant.id, rel: 'keep.txt' };
    await files.write(ref, new Uint8Array([1]), { ifAbsent: true });
    await expect(
      files.write(ref, new Uint8Array([2]), { ifAbsent: true }),
    ).rejects.toThrow();
    expect(await files.read(ref)).toEqual(new Uint8Array([1]));
  });

  it('stats ordinary files without treating the final file as an ancestor', async () => {
    const ref = { root: grant.id, rel: 'ordinary.txt' };
    await files.write(ref, new Uint8Array([1]));
    await expect(files.stat(ref)).resolves.toMatchObject({ kind: 'file' });
  });

  it('supports metadata operations on the approved root itself', async () => {
    await expect(
      files.stat({ root: grant.id, rel: '' }),
    ).resolves.toMatchObject({ kind: 'directory' });
    await expect(
      files.lstat({ root: grant.id, rel: '.' }),
    ).resolves.toMatchObject({ kind: 'directory' });
    await expect(
      files.canonical({ root: grant.id, rel: '.' }),
    ).resolves.toEqual({ root: grant.id, rel: '' });
  });

  it('rejects a final symlink and refuses removal through a symlinked parent', async () => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expect(
      files.stat({ root: grant.id, rel: 'link.txt' }),
    ).rejects.toThrow();
    await symlink(outside, join(root, 'parent-link'));
    await expect(
      files.remove({ root: grant.id, rel: 'parent-link/secret.txt' }),
    ).rejects.toThrow();
  });

  it('pages directory listings with opaque cursors', async () => {
    await Promise.all(
      ['a.txt', 'b.txt', 'c.txt'].map((name) =>
        files.write({ root: grant.id, rel: name }, new Uint8Array([1])),
      ),
    );
    const first = await files.list({ root: grant.id, rel: '' }, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    expect(JSON.stringify(first.nextCursor)).not.toContain(root);
    const second = await files.list(
      { root: grant.id, rel: '' },
      { cursor: first.nextCursor, limit: 2 },
    );
    expect(second.entries).toHaveLength(1);
  });

  it('binds cursors to their source directory', async () => {
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await Promise.all(
      ['a', 'b'].flatMap((dir) =>
        ['1', '2', '3'].map((name) =>
          files.write(
            { root: grant.id, rel: `${dir}/${name}.txt` },
            new Uint8Array([1]),
          ),
        ),
      ),
    );
    const first = await files.list({ root: grant.id, rel: 'a' }, { limit: 2 });
    await expect(
      files.list(
        { root: grant.id, rel: 'b' },
        { cursor: first.nextCursor, limit: 2 },
      ),
    ).rejects.toThrow();
  });

  it('rejects root-equivalent mutation references', async () => {
    await expect(files.remove({ root: grant.id, rel: '.' })).rejects.toThrow();
    await expect(
      files.move(
        { root: grant.id, rel: '.' },
        { root: grant.id, rel: 'moved-root' },
      ),
    ).rejects.toThrow();
  });

  it('rejects a replacement of the approved root directory', async () => {
    movedRoot = `${root}-moved`;
    await rename(root, movedRoot);
    await mkdir(root);
    await writeFile(join(root, 'replacement.txt'), 'replacement');
    await expect(
      files.read({ root: grant.id, rel: 'replacement.txt' }),
    ).rejects.toThrow(/root|identity|approved/i);
  });

  it('cleans up native watchers when closed or disposed', async () => {
    const events: unknown[] = [];
    const watch = await files.watch(
      { root: grant.id, rel: '' },
      (event: FileChange) => events.push(event),
    );
    await watch.close();
    await files.write(
      { root: grant.id, rel: 'after-close.txt' },
      new Uint8Array([1]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toHaveLength(0);
  });

  it('translates controlled watcher errors to rescan and closes the watcher', async () => {
    const fake = new EventEmitter() as unknown as nodeFs.FSWatcher;
    fake.close = jest.fn();
    let callback: ((event: string, name: string) => void) | undefined;
    const controlled = createScopedFiles({
      owner: 'documents',
      roots: registry,
      watch: ((_path, _options, onEvent) => {
        callback = onEvent as (event: string, name: string) => void;
        return fake;
      }) as typeof nodeFs.watch,
    });
    try {
      const events: FileChange[] = [];
      const watch = await controlled.watch(
        { root: grant.id, rel: '' },
        (event) => events.push(event),
      );
      fake.emit('error', new Error('EMFILE'));
      expect(fake.close).toHaveBeenCalled();
      expect(events).toEqual([
        { ref: { root: grant.id, rel: '' }, kind: 'rescan' },
      ]);
      expect(callback).toBeDefined();
      await watch.close();
    } finally {
      await controlled.dispose();
    }
  });

  it('moves without replacing an existing destination', async () => {
    await files.write({ root: grant.id, rel: 'from.txt' }, new Uint8Array([1]));
    await files.write({ root: grant.id, rel: 'to.txt' }, new Uint8Array([2]));
    await expect(
      files.move(
        { root: grant.id, rel: 'from.txt' },
        { root: grant.id, rel: 'to.txt' },
      ),
    ).rejects.toThrow();
    expect(await files.read({ root: grant.id, rel: 'to.txt' })).toEqual(
      new Uint8Array([2]),
    );
  });

  it('successfully moves bytes, preserves metadata, and removes the source', async () => {
    const source = { root: grant.id, rel: 'successful-source.txt' };
    const destination = { root: grant.id, rel: 'successful-destination.txt' };
    const bytes = new Uint8Array([9, 8, 7, 6]);
    await files.write(source, bytes);
    const before = await files.stat(source);
    await files.move(source, destination);
    await expect(files.read(destination)).resolves.toEqual(bytes);
    await expect(files.read(source)).rejects.toThrow();
    await expect(files.stat(destination)).resolves.toMatchObject({
      mode: before.mode,
      mtimeMs: expect.closeTo(before.mtimeMs, 2),
    });
  });

  it('supports owner-bound handles and rejects closed handles', async () => {
    await files.write(
      { root: grant.id, rel: 'handle.txt' },
      new Uint8Array([4, 5]),
    );
    const handle = await files.open({ root: grant.id, rel: 'handle.txt' }, 'r');
    const info = await files.fstat(handle);
    expect(info.ino).toEqual(expect.any(String));
    expect(await files.readHandle(handle, { offset: 1, maxBytes: 1 })).toEqual(
      new Uint8Array([5]),
    );
    await files.closeHandle(handle);
    await expect(files.fstat(handle)).rejects.toThrow();
  });

  it('keeps read handles read-only even when their root is writable', async () => {
    const ref = { root: grant.id, rel: 'read-only-handle.txt' };
    await files.write(ref, new Uint8Array([1]));
    const handle = await files.open(ref, 'r');
    await expect(
      files.writeHandle(handle, new Uint8Array([2])),
    ).rejects.toThrow(/read.only|mode/i);
    await expect(
      files.setHandleMetadata(handle, { mode: 0o600 }),
    ).rejects.toThrow(/read.only|mode/i);
    await files.closeHandle(handle);
  });

  it('sets handle metadata using millisecond API values', async () => {
    const ref = { root: grant.id, rel: 'metadata-handle.txt' };
    const handle = await files.open(ref, 'wx');
    const mtimeMs = 1_700_000_123_456.5;
    await files.setHandleMetadata(handle, { mtimeMs });
    await files.closeHandle(handle);
    await expect(files.stat(ref)).resolves.toMatchObject({
      mtimeMs: expect.closeTo(mtimeMs, 2),
    });
  });

  it('requires a writable source before deleting it during a move', async () => {
    const sourceRoot = await registry.grant('documents', outside, {
      name: 'Source',
      writable: false,
    });
    await writeFile(join(outside, 'source.txt'), 'source');
    await expect(
      files.move(
        { root: sourceRoot.id, rel: 'source.txt' },
        { root: grant.id, rel: 'copied.txt' },
      ),
    ).rejects.toThrow(/read.only|writable/i);
    await expect(readFile(join(outside, 'source.txt'))).resolves.toEqual(
      Buffer.from('source'),
    );
  });

  it('preserves a replacement injected before final move validation', async () => {
    const source = join(root, 'race-source.txt');
    const replacement = join(root, 'race-replacement.txt');
    await writeFile(source, Buffer.from([7, 7, 7]));
    let sourceChecks = 0;
    const originalLstat = fsPromises.lstat.bind(fsPromises);
    const raced = createScopedFiles({
      owner: 'documents',
      roots: registry,
      lstat: (async (pathArg: PathLike, options?: StatOptions) => {
        const result = await originalLstat(pathArg, options as never);
        if (
          String(pathArg).endsWith('race-source.txt') &&
          sourceChecks++ === 1
        ) {
          await rename(source, replacement);
          await writeFile(source, 'replacement');
        }
        return result;
      }) as typeof fsPromises.lstat,
    });
    await expect(
      raced.move(
        { root: grant.id, rel: 'race-source.txt' },
        { root: grant.id, rel: 'race-destination.txt' },
      ),
    ).rejects.toThrow(/changed|identity|source/i);
    await raced.dispose();
    await expect(readFile(source, 'utf8')).resolves.toBe('replacement');
    await expect(
      files.read({ root: grant.id, rel: 'race-destination.txt' }),
    ).rejects.toThrow();
  });

  it('reports exact identity fields and preserves sub-millisecond mtime', async () => {
    await files.write(
      { root: grant.id, rel: 'identity.txt' },
      new Uint8Array([7]),
    );
    const info = await files.stat({ root: grant.id, rel: 'identity.txt' });
    expect(info.dev).toEqual(expect.any(String));
    expect(info.ino).toEqual(expect.any(String));
    expect(info.nlink).toEqual(expect.any(Number));
    expect(info.mtimeMs % 1).not.toBeNaN();
  });

  it('does not expose raw root paths in file replies', async () => {
    await files.write(
      { root: grant.id, rel: 'reply.txt' },
      new Uint8Array([1]),
    );
    const listed = await files.list({ root: grant.id, rel: '' });
    expect(JSON.stringify(listed)).not.toContain(root);
    expect(await readFile(join(root, 'reply.txt'))).toEqual(Buffer.from([1]));
  });
});
