/** @jest-environment node */
import fsPromises, {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import type { PathLike, StatOptions } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FileChange } from '@shared/plugin-files';
import { createFileRootRegistry } from '../file-roots';
import { createScopedFiles } from '../scoped-files';

type ExtendedWriteOptions = {
  ifAbsent?: boolean;
  atomic?: boolean;
  mode?: number;
};

async function writeWithOptions(
  files: ReturnType<typeof createScopedFiles>,
  ref: { root: string; rel: string },
  data: Uint8Array,
  options?: ExtendedWriteOptions,
): Promise<void> {
  await files.write(ref, data, options);
}

function injectFileHandleWrite(
  marker: string,
  outcome: 'partial-then-throw' | 'zero-then-throw',
): { spy: jest.SpiedFunction<typeof fsPromises.open>; writes: () => number } {
  const originalOpen = fsPromises.open.bind(fsPromises);
  let writes = 0;
  const spy = jest.spyOn(fsPromises, 'open');
  spy.mockImplementation(
    async (...args: Parameters<typeof fsPromises.open>) => {
      const [filePath, flags, mode] = args;
      const file =
        mode === undefined
          ? await originalOpen(filePath, flags)
          : await originalOpen(filePath, flags, mode);
      if (!String(args[0]).includes(marker)) return file;
      const originalWrite = file.write.bind(file);
      file.write = (async (...writeArgs: any[]) => {
        writes += 1;
        if (writes === 1 && outcome === 'partial-then-throw') {
          const buffer = writeArgs[0] as Uint8Array;
          const offset = Number(writeArgs[1]);
          const length = Number(writeArgs[2]);
          await originalWrite(
            buffer,
            offset,
            Math.max(1, Math.floor(length / 2)),
          );
          throw new Error('injected partial write failure');
        }
        if (writes === 1 && outcome === 'zero-then-throw') {
          return { bytesWritten: 0, buffer: writeArgs[0] };
        }
        throw new Error('injected retry after zero write');
      }) as typeof file.write;
      return file;
    },
  );
  return { spy, writes: () => writes };
}

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

  it('atomically replaces bytes, applies the requested mode, and preserves the old value on partial failure', async () => {
    const ref = { root: grant.id, rel: 'atomic-failure.txt' };
    await writeWithOptions(files, ref, new Uint8Array([1, 2, 3]), {
      atomic: true,
      mode: 0o600,
    });

    await writeWithOptions(files, ref, new Uint8Array([4, 5, 6]), {
      atomic: true,
      mode: 0o640,
    });
    await expect(files.read(ref)).resolves.toEqual(new Uint8Array([4, 5, 6]));
    await expect(files.stat(ref)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    expect((await files.stat(ref)).mode & 0o777).toBe(0o640);

    const preserveRef = { root: grant.id, rel: 'atomic-preserve-mode.txt' };
    await writeWithOptions(files, preserveRef, new Uint8Array([1]), {
      atomic: true,
      mode: 0o600,
    });
    await writeWithOptions(files, preserveRef, new Uint8Array([2]), {
      atomic: true,
    });
    expect((await files.stat(preserveRef)).mode & 0o777).toBe(0o600);

    const injected = injectFileHandleWrite(
      'atomic-failure.txt',
      'partial-then-throw',
    );
    try {
      await expect(
        writeWithOptions(files, ref, new Uint8Array([7, 8, 9, 10]), {
          atomic: true,
        }),
      ).rejects.toThrow(/partial write/i);
    } finally {
      injected.spy.mockRestore();
    }
    await expect(files.read(ref)).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(injected.writes()).toBe(1);
    const listed = await files.list({ root: grant.id, rel: '' });
    expect(listed.entries.map((entry) => entry.name).sort()).toEqual([
      'atomic-failure.txt',
      'atomic-preserve-mode.txt',
    ]);
  });

  it('keeps atomic ifAbsent collisions and rejects invalid modes without a symlink escape', async () => {
    const ref = { root: grant.id, rel: 'atomic-collision.txt' };
    await writeWithOptions(files, ref, new Uint8Array([1]), {
      atomic: true,
      ifAbsent: true,
      mode: 0o600,
    });
    await expect(files.stat(ref)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
    expect((await files.stat(ref)).mode & 0o777).toBe(0o600);
    await expect(
      writeWithOptions(files, ref, new Uint8Array([2]), {
        atomic: true,
        ifAbsent: true,
      }),
    ).rejects.toThrow();
    await expect(files.read(ref)).resolves.toEqual(new Uint8Array([1]));

    await expect(
      writeWithOptions(
        files,
        { root: grant.id, rel: 'invalid-mode.txt' },
        new Uint8Array([3]),
        { atomic: true, mode: 0o1000 },
      ),
    ).rejects.toThrow(/mode/i);

    const outsideTarget = join(outside, 'atomic-outside.txt');
    await writeFile(outsideTarget, 'committed');
    await symlink(outsideTarget, join(root, 'atomic-link.txt'));
    await expect(
      writeWithOptions(
        files,
        { root: grant.id, rel: 'atomic-link.txt' },
        new Uint8Array([9]),
        { atomic: true },
      ),
    ).rejects.toThrow(/symlink|path|root/i);
    await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('committed');
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

  it('rejects expired cursor state after bounded cursor retention', async () => {
    await mkdir(join(root, 'cursor-bounded'));
    await Promise.all(
      Array.from({ length: 260 }, (_, index) =>
        files.write(
          { root: grant.id, rel: `cursor-bounded/${index}.txt` },
          new Uint8Array([1]),
        ),
      ),
    );
    const first = await files.list(
      { root: grant.id, rel: 'cursor-bounded' },
      { limit: 1 },
    );
    let cursor = first.nextCursor;
    let recentCursor = cursor;
    for (let index = 0; index < 258 && cursor; index += 1) {
      cursor = (
        await files.list(
          { root: grant.id, rel: 'cursor-bounded' },
          { cursor, limit: 1 },
        )
      ).nextCursor;
      recentCursor = cursor ?? recentCursor;
    }
    if (recentCursor) {
      await expect(
        files.list(
          { root: grant.id, rel: 'cursor-bounded' },
          { cursor: recentCursor, limit: 1 },
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      files.list(
        { root: grant.id, rel: 'cursor-bounded' },
        { cursor: first.nextCursor, limit: 1 },
      ),
    ).rejects.toThrow(/expired|invalid|cursor/i);
  });

  it('closes an opendir handle when entry stat fails', async () => {
    let closed = false;
    const originalOpendir = fsPromises.opendir.bind(fsPromises);
    const opendirSpy = jest
      .spyOn(fsPromises, 'opendir')
      .mockImplementation((async (
        ...args: Parameters<typeof fsPromises.opendir>
      ) => {
        const directory = await originalOpendir(...args);
        const originalClose = directory.close.bind(directory);
        directory.close = async () => {
          closed = true;
          return originalClose();
        };
        return directory;
      }) as typeof fsPromises.opendir);
    const failing = createScopedFiles({
      owner: 'documents',
      roots: registry,
      lstat: (async (pathArg: PathLike, options?: StatOptions) => {
        if (String(pathArg).endsWith('directory-entry.txt')) {
          throw new Error('injected entry stat failure');
        }
        return fsPromises.lstat(pathArg, options as never);
      }) as typeof fsPromises.lstat,
    });
    await files.write(
      { root: grant.id, rel: 'directory-entry.txt' },
      new Uint8Array([1]),
    );
    try {
      await expect(
        failing.list({ root: grant.id, rel: '' }, { limit: 1 }),
      ).rejects.toThrow('injected entry stat failure');
      expect(closed).toBe(true);
    } finally {
      opendirSpy.mockRestore();
      await failing.dispose();
    }
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

  it('closes a watcher when revocation occurs during native setup', async () => {
    const fake = new EventEmitter() as unknown as nodeFs.FSWatcher;
    fake.close = jest.fn();
    const racing = createScopedFiles({
      owner: 'documents',
      roots: registry,
      watch: (() => {
        void registry.revoke('documents', grant.id);
        return fake;
      }) as typeof nodeFs.watch,
    });
    await racing.watch({ root: grant.id, rel: '' }, () => undefined);
    expect(fake.close).toHaveBeenCalled();
    await racing.dispose();
  });

  it('does not create a native watcher after disposal during awaited setup', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watchFactory = jest.fn(() => {
      throw new Error('native watcher must not start');
    });
    const late = createScopedFiles({
      owner: 'documents',
      roots: registry,
      watch: watchFactory as typeof nodeFs.watch,
      lstat: (async (pathArg: PathLike, options?: StatOptions) => {
        if (basename(String(pathArg)) === basename(root)) {
          entered();
          await blocked;
        }
        return fsPromises.lstat(pathArg, options as never);
      }) as typeof fsPromises.lstat,
    });
    const setup = late.watch({ root: grant.id, rel: '' }, () => undefined);
    await reached;
    await late.dispose();
    release();
    await expect(setup).rejects.toThrow(/disposed|aborted|lifetime/i);
    expect(watchFactory).not.toHaveBeenCalled();
  });

  it('does not create a native watcher after owner abort during awaited setup', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const watchFactory = jest.fn(() => {
      throw new Error('native watcher must not start');
    });
    const late = createScopedFiles({
      owner: 'documents',
      roots: registry,
      signal: controller.signal,
      watch: watchFactory as typeof nodeFs.watch,
      lstat: (async (pathArg: PathLike, options?: StatOptions) => {
        if (basename(String(pathArg)) === basename(root)) {
          entered();
          await blocked;
        }
        return fsPromises.lstat(pathArg, options as never);
      }) as typeof fsPromises.lstat,
    });
    const setup = late.watch({ root: grant.id, rel: '' }, () => undefined);
    await reached;
    controller.abort();
    release();
    await expect(setup).rejects.toThrow(/disposed|aborted|lifetime/i);
    expect(watchFactory).not.toHaveBeenCalled();
    await late.dispose();
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

  it('rejects zero-byte progress from the direct write loop', async () => {
    const injected = injectFileHandleWrite(
      'direct-zero.txt',
      'zero-then-throw',
    );
    try {
      await expect(
        writeWithOptions(
          files,
          { root: grant.id, rel: 'direct-zero.txt' },
          new Uint8Array([1, 2]),
        ),
      ).rejects.toThrow(/zero|progress/i);
      expect(injected.writes()).toBe(1);
    } finally {
      injected.spy.mockRestore();
    }
  });

  it('rejects zero-byte progress from the handle write loop', async () => {
    const injected = injectFileHandleWrite(
      'handle-zero.txt',
      'zero-then-throw',
    );
    const ref = { root: grant.id, rel: 'handle-zero.txt' };
    const handle = await files.open(ref, 'wx');
    try {
      await expect(
        files.writeHandle(handle, new Uint8Array([1, 2])),
      ).rejects.toThrow(/zero|progress/i);
      expect(injected.writes()).toBe(1);
    } finally {
      await files.closeHandle(handle);
      injected.spy.mockRestore();
    }
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

  it('rejects zero-byte progress from the move copy loop and removes the partial destination', async () => {
    const source = { root: grant.id, rel: 'move-zero-source.txt' };
    const destination = { root: grant.id, rel: 'move-zero-destination.txt' };
    await files.write(source, new Uint8Array([7, 7, 7]));
    const injected = injectFileHandleWrite(
      'move-zero-destination.txt',
      'zero-then-throw',
    );
    try {
      await expect(files.move(source, destination)).rejects.toThrow(
        /zero|progress/i,
      );
      expect(injected.writes()).toBe(1);
    } finally {
      injected.spy.mockRestore();
    }
    await expect(files.read(source)).resolves.toEqual(
      new Uint8Array([7, 7, 7]),
    );
    await expect(files.read(destination)).rejects.toThrow();
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

  it('forwards native blocks through stat and fstat and matches Number-stat mtime exactly', async () => {
    const ref = { root: grant.id, rel: 'native-stat-fields.txt' };
    const filePath = join(root, ref.rel);
    await files.write(ref, new Uint8Array(4097).fill(7));
    const native = await fsPromises.stat(filePath);
    const scoped = await files.stat(ref);
    const handle = await files.open(ref, 'r');
    const scopedHandle = await files.fstat(handle);
    await files.closeHandle(handle);

    expect(scoped.blocks).toBe(native.blocks);
    expect(scopedHandle.blocks).toBe(native.blocks);

    const subMillisecondSeconds = 1_700_000_123.456789;
    await fsPromises.utimes(
      filePath,
      subMillisecondSeconds,
      subMillisecondSeconds,
    );
    const nativeAfter = await fsPromises.stat(filePath);
    const scopedAfter = await files.stat(ref);
    expect(nativeAfter.mtimeMs % 1).not.toBe(0);
    expect(scopedAfter.mtimeMs).toBe(nativeAfter.mtimeMs);
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
