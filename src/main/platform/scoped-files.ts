import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  FileChange,
  FileEntry,
  FileInfo,
  FileRef,
  FileRoot,
  ScopedFileHandle,
  ScopedFiles,
} from '@shared/plugin-files';
import type { FileRootRegistry } from './file-roots';

const MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;
const MAX_CURSORS = 256;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DEFAULT_NEW_FILE_MODE = 0o600;

async function digestFile(filePath: string): Promise<string> {
  const file = await fsp.open(filePath, fs.constants.O_RDONLY | NOFOLLOW);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await file.close();
  }
}
type Root = Awaited<ReturnType<FileRootRegistry['resolve']>>;
type Cursor = { root: string; rel: string; index: number };

export interface ScopedFilesOptions {
  /** Stable grant namespace shared by all activations of this plugin. */
  pluginId: string;
  /** Activation/incarnation owner for handles, watchers and subscriptions. */
  owner: string;
  roots: FileRootRegistry;
  signal?: AbortSignal;
  emit?: (event: FileChange) => void;
  log?: (message: string) => void;
  lstat?: typeof fsp.lstat;
  watch?: typeof fs.watch;
}

function validateRel(rel: string): string {
  if (rel.includes('\0')) throw new Error('path contains NUL');
  if (
    path.posix.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    /^\\\\/.test(rel)
  )
    throw new Error('absolute paths are not allowed');
  if (/^[A-Za-z]:/.test(rel)) throw new Error('drive paths are not allowed');
  const normalized = rel.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..'))
    throw new Error('path traversal is not allowed');
  const normalizedParts = parts.filter((part) => part !== '.');
  return normalizedParts.join('/');
}

function info(stat: fs.Stats | fs.BigIntStats): FileInfo {
  let kind: FileInfo['kind'] = 'other';
  if (stat.isFile()) kind = 'file';
  else if (stat.isDirectory()) kind = 'directory';
  return {
    kind,
    size: Number(stat.size),
    blocks: Number('blocks' in stat ? stat.blocks : 0),
    mtimeMs:
      'mtimeNs' in stat
        ? Number(stat.mtimeNs / 1_000_000n) +
          Number(stat.mtimeNs % 1_000_000n) / 1e6
        : Number(stat.mtimeMs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: Number(stat.nlink),
    mode: Number(stat.mode),
    symbolicLink: stat.isSymbolicLink(),
  };
}

function validateMode(mode: number | undefined): number | undefined {
  if (
    mode !== undefined &&
    (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)
  )
    throw new Error('file mode must be an integer from 0 through 0o777');
  return mode;
}

async function writeAll(
  file: fs.promises.FileHandle,
  data: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await file.write(data, offset, data.byteLength - offset);
    if (result.bytesWritten <= 0)
      throw new Error('file write made no progress');
    offset += result.bytesWritten;
  }
}

function under(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function createScopedFiles(
  options: ScopedFilesOptions,
): ScopedFiles & { dispose(): Promise<void> } {
  const incarnation = randomUUID();
  const handles = new Map<
    string,
    {
      file: fs.promises.FileHandle;
      rootId: string;
      path: string;
      mode: 'r' | 'wx';
    }
  >();
  const watchers = new Set<fs.FSWatcher>();
  const watcherCleanups = new Set<() => void>();
  const cursors = new Map<string, Cursor>();
  let disposed = false;
  const lstat = options.lstat ?? fsp.lstat;
  const watch = options.watch ?? fs.watch;
  let abortListener: (() => void) | undefined;

  const check = () => {
    if (disposed) throw new Error('scoped files service is disposed');
    if (options.signal?.aborted)
      throw new Error('scoped files service is aborted');
  };

  const resolve = async (
    ref: FileRef,
  ): Promise<{ root: Root; path: string; rel: string }> => {
    check();
    const root = await options.roots.resolve(options.pluginId, ref.root);
    const rel = validateRel(ref.rel);
    const target = path.resolve(root.path, ...(rel ? rel.split('/') : []));
    if (!under(root.path, target)) throw new Error('path escapes file root');
    return { root, path: target, rel };
  };

  const ensureAncestors = async (root: Root, target: string) => {
    const rootPath = root.path;
    if (!under(rootPath, target)) throw new Error('path escapes file root');
    const rootStat = await lstat(rootPath, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new Error('approved root changed');
    if (String(rootStat.dev) !== root.dev || String(rootStat.ino) !== root.ino)
      throw new Error('approved root identity changed');
    const rel = path.relative(rootPath, target);
    let current = rootPath;
    for (const segment of rel ? rel.split(path.sep) : []) {
      current = path.join(current, segment);
      try {
        const st = await lstat(current);
        if (st.isSymbolicLink() || !st.isDirectory())
          throw new Error('symlink or non-directory ancestor');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  };

  const writable = (root: Root) => {
    if (!root.writable) throw new Error('file root is read-only');
  };

  const checkedStat = async (
    target: string,
    follow: boolean,
  ): Promise<FileInfo> => {
    const st = follow
      ? await fsp.stat(target, { bigint: true })
      : await lstat(target, { bigint: true });
    return info(st);
  };

  const getHandle = async (handle: ScopedFileHandle) => {
    check();
    const value = handles.get(handle.id);
    if (!value || !handle.id.startsWith(`${incarnation}:`))
      throw new Error('invalid or closed file handle');
    try {
      await options.roots.resolve(options.pluginId, value.rootId);
    } catch {
      handles.delete(handle.id);
      await value.file.close().catch(() => undefined);
      throw new Error('file handle root is revoked');
    }
    return value;
  };

  const service: ScopedFiles & { dispose(): Promise<void> } = {
    async roots(): Promise<FileRoot[]> {
      check();
      return options.roots.roots(options.pluginId);
    },
    async stat(ref) {
      const resolved = await resolve(ref);
      await ensureAncestors(
        resolved.root,
        resolved.rel ? path.dirname(resolved.path) : resolved.path,
      );
      const final = await lstat(resolved.path);
      if (final.isSymbolicLink())
        throw new Error('symlink targets are not allowed');
      return checkedStat(resolved.path, true);
    },
    async lstat(ref) {
      const resolved = await resolve(ref);
      await ensureAncestors(
        resolved.root,
        resolved.rel ? path.dirname(resolved.path) : resolved.path,
      );
      return checkedStat(resolved.path, false);
    },
    async canonical(ref) {
      const resolved = await resolve(ref);
      await ensureAncestors(
        resolved.root,
        resolved.rel ? path.dirname(resolved.path) : resolved.path,
      );
      const canonical = await fsp.realpath(resolved.path);
      if (!under(resolved.root.path, canonical))
        throw new Error('canonical path escapes file root');
      return {
        root: resolved.root.id,
        rel: path
          .relative(resolved.root.path, canonical)
          .split(path.sep)
          .join('/'),
      };
    },
    async mkdir(ref) {
      const resolved = await resolve(ref);
      writable(resolved.root);
      await ensureAncestors(resolved.root, path.dirname(resolved.path));
      await fsp.mkdir(resolved.path);
    },
    async open(ref, mode) {
      if (mode !== 'r' && mode !== 'wx')
        throw new Error('invalid file open mode');
      const resolved = await resolve(ref);
      if (mode === 'wx') writable(resolved.root);
      await ensureAncestors(resolved.root, path.dirname(resolved.path));
      if (mode === 'r' && (await lstat(resolved.path)).isSymbolicLink())
        throw new Error('symlink targets are not allowed');
      const file = await fsp.open(
        resolved.path,
        mode === 'r' ? fs.constants.O_RDONLY | NOFOLLOW : 'wx',
      );
      try {
        check();
        await options.roots.resolve(options.pluginId, resolved.root.id);
        const id = `${incarnation}:${randomUUID()}`;
        handles.set(id, {
          file,
          rootId: resolved.root.id,
          path: resolved.path,
          mode,
        });
        return { id };
      } catch (error) {
        await file.close().catch(() => undefined);
        throw error;
      }
    },
    async fstat(handle) {
      return info(await (await getHandle(handle)).file.stat({ bigint: true }));
    },
    async readHandle(handle, readOptions) {
      if (
        !Number.isSafeInteger(readOptions.offset) ||
        readOptions.offset < 0 ||
        !Number.isSafeInteger(readOptions.maxBytes) ||
        readOptions.maxBytes < 0 ||
        readOptions.maxBytes > MAX_BYTES
      )
        throw new Error('invalid or oversized read');
      const value = await getHandle(handle);
      const buffer = Buffer.allocUnsafe(readOptions.maxBytes);
      const result = await value.file.read(
        buffer,
        0,
        readOptions.maxBytes,
        readOptions.offset,
      );
      return new Uint8Array(buffer.subarray(0, result.bytesRead));
    },
    async writeHandle(handle, data) {
      if (data.byteLength > MAX_BYTES)
        throw new Error('write exceeds 16 MiB limit');
      const value = await getHandle(handle);
      if (value.mode !== 'wx') throw new Error('read-only handle');
      const root = await options.roots.resolve(options.pluginId, value.rootId);
      writable(root);
      await writeAll(value.file, data);
    },
    async syncHandle(handle) {
      await (await getHandle(handle)).file.sync();
    },
    async setHandleMetadata(handle, metadata) {
      const value = await getHandle(handle);
      if (value.mode !== 'wx') throw new Error('read-only handle');
      const root = await options.roots.resolve(options.pluginId, value.rootId);
      writable(root);
      if (metadata.mode !== undefined) await value.file.chmod(metadata.mode);
      if (metadata.atimeMs !== undefined || metadata.mtimeMs !== undefined) {
        const st = await value.file.stat();
        await value.file.utimes(
          Number(metadata.atimeMs ?? st.atimeMs) / 1000,
          Number(metadata.mtimeMs ?? st.mtimeMs) / 1000,
        );
      }
    },
    async closeHandle(handle) {
      const value = await getHandle(handle);
      handles.delete(handle.id);
      await value.file.close();
    },
    async link(from, to) {
      const source = await resolve(from);
      const destination = await resolve(to);
      writable(destination.root);
      await ensureAncestors(source.root, path.dirname(source.path));
      await ensureAncestors(destination.root, path.dirname(destination.path));
      await fsp.link(source.path, destination.path);
    },
    async list(ref, listOptions = {}) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root, resolved.path);
      const limit = Math.min(
        Math.max(listOptions.limit ?? DEFAULT_PAGE, 1),
        MAX_PAGE,
      );
      let cursor: Cursor = {
        root: resolved.root.id,
        rel: resolved.rel,
        index: 0,
      };
      if (listOptions.cursor) {
        const saved = cursors.get(listOptions.cursor);
        if (
          !saved ||
          saved.root !== resolved.root.id ||
          saved.rel !== resolved.rel
        )
          throw new Error('invalid cursor');
        cursor = saved;
      }
      const result: { entries: FileEntry[]; nextCursor?: string } = {
        entries: [],
      };
      const directory = await fsp.opendir(resolved.path);
      let hasMore = false;
      try {
        let index = 0;
        let entry: fs.Dirent | null;
        while ((entry = await directory.read()) !== null) {
          if (index++ < cursor.index) continue;
          const entryInfo = await checkedStat(
            path.join(resolved.path, entry.name),
            false,
          );
          result.entries.push({ name: entry.name, ...entryInfo });
          if (result.entries.length >= limit) {
            hasMore = (await directory.read()) !== null;
            break;
          }
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      if (hasMore) {
        const token = `${incarnation}:${randomUUID()}`;
        if (cursors.size >= MAX_CURSORS) {
          const oldest = cursors.keys().next().value;
          if (oldest) cursors.delete(oldest);
        }
        cursors.set(token, {
          root: resolved.root.id,
          rel: resolved.rel,
          index: cursor.index + result.entries.length,
        });
        result.nextCursor = token;
      }
      return result;
    },
    async read(ref, readOptions = {}) {
      const offset = readOptions.offset ?? 0;
      const maxBytes = readOptions.maxBytes ?? MAX_BYTES;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > MAX_BYTES
      )
        throw new Error('invalid or oversized read');
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root, path.dirname(resolved.path));
      if ((await lstat(resolved.path)).isSymbolicLink())
        throw new Error('symlink targets are not allowed');
      const file = await fsp.open(
        resolved.path,
        fs.constants.O_RDONLY | NOFOLLOW,
      );
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const result = await file.read(buffer, 0, maxBytes, offset);
        return new Uint8Array(buffer.subarray(0, result.bytesRead));
      } finally {
        await file.close();
      }
    },
    async write(ref, data, writeOptions = {}) {
      if (data.byteLength > MAX_BYTES)
        throw new Error('write exceeds 16 MiB limit');
      const requestedMode = validateMode(writeOptions.mode);
      const resolved = await resolve(ref);
      writable(resolved.root);
      const parentPath = path.dirname(resolved.path);
      await ensureAncestors(resolved.root, parentPath);

      let existingMode: number | undefined;
      try {
        const destination = await lstat(resolved.path, { bigint: true });
        if (destination.isSymbolicLink())
          throw new Error('symlink targets are not allowed');
        existingMode = Number(destination.mode) & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      if (writeOptions.atomic) {
        const targetMode =
          requestedMode ?? existingMode ?? DEFAULT_NEW_FILE_MODE;
        const temporaryPath = path.join(
          parentPath,
          `.${path.basename(resolved.path)}.${incarnation}.${randomUUID()}.tmp`,
        );
        let file: fs.promises.FileHandle | undefined;
        let published = false;
        try {
          file = await fsp.open(
            temporaryPath,
            fs.constants.O_WRONLY |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              NOFOLLOW,
            targetMode,
          );
          await writeAll(file, data);
          await file.sync();
          await file.chmod(targetMode);
          await file.close();
          file = undefined;

          await ensureAncestors(resolved.root, parentPath);
          if (writeOptions.ifAbsent) {
            await fsp.link(temporaryPath, resolved.path);
            await fsp.unlink(temporaryPath);
          } else {
            await fsp.rename(temporaryPath, resolved.path);
          }
          published = true;
        } finally {
          await file?.close().catch(() => undefined);
          if (!published)
            await fsp.unlink(temporaryPath).catch(() => undefined);
        }
        return;
      }

      const flags = writeOptions.ifAbsent
        ? fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          NOFOLLOW
        : fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          NOFOLLOW;
      const file = await fsp.open(
        resolved.path,
        flags,
        requestedMode ?? DEFAULT_NEW_FILE_MODE,
      );
      try {
        await writeAll(file, data);
        if (requestedMode !== undefined) await file.chmod(requestedMode);
        await file.sync();
      } finally {
        await file.close();
      }
    },
    async move(from, to) {
      const source = await resolve(from);
      const destination = await resolve(to);
      if (!from.rel || !to.rel) throw new Error('cannot move an approved root');
      writable(source.root);
      writable(destination.root);
      await ensureAncestors(source.root, path.dirname(source.path));
      await ensureAncestors(destination.root, path.dirname(destination.path));
      const sourceInfo = await lstat(source.path, { bigint: true });
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile())
        throw new Error('move requires a regular file');
      const sourceDigest = createHash('sha256');
      let input: fs.promises.FileHandle | undefined;
      let output: fs.promises.FileHandle | undefined;
      let destinationIdentity: fs.BigIntStats | undefined;
      const cleanupDestination = async () => {
        if (!destinationIdentity) return;
        try {
          const current = await lstat(destination.path, { bigint: true });
          if (
            String(current.dev) === String(destinationIdentity.dev) &&
            String(current.ino) === String(destinationIdentity.ino)
          )
            await fsp.unlink(destination.path);
        } catch {
          // The destination is already gone or was replaced; leave it alone.
        }
      };
      try {
        input = await fsp.open(source.path, fs.constants.O_RDONLY | NOFOLLOW);
        output = await fsp.open(destination.path, 'wx');
        destinationIdentity = await output.stat({ bigint: true });
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        for (;;) {
          const result = await input.read(buffer, 0, buffer.length, position);
          if (result.bytesRead === 0) break;
          sourceDigest.update(buffer.subarray(0, result.bytesRead));
          await writeAll(output, buffer.subarray(0, result.bytesRead));
          position += result.bytesRead;
        }
        await output.sync();
        await output.chmod(Number(sourceInfo.mode));
        await output.utimes(
          Number(sourceInfo.atimeNs) / 1e9,
          Number(sourceInfo.mtimeNs) / 1e9,
        );
        const current = await lstat(source.path, { bigint: true });
        const currentDigest = await digestFile(source.path);
        const finalHandleStat = await input.stat({ bigint: true });
        await ensureAncestors(source.root, path.dirname(source.path));
        if (
          String(current.dev) !== String(sourceInfo.dev) ||
          String(current.ino) !== String(sourceInfo.ino) ||
          String(finalHandleStat.dev) !== String(sourceInfo.dev) ||
          String(finalHandleStat.ino) !== String(sourceInfo.ino) ||
          current.size !== sourceInfo.size ||
          current.mtimeNs !== sourceInfo.mtimeNs ||
          finalHandleStat.size !== sourceInfo.size ||
          finalHandleStat.mtimeNs !== sourceInfo.mtimeNs ||
          sourceDigest.digest('hex') !== currentDigest
        ) {
          await cleanupDestination();
          throw new Error('source changed during move');
        }
        await fsp.unlink(source.path);
      } catch (error) {
        await cleanupDestination();
        throw error;
      } finally {
        await output?.close().catch(() => undefined);
        await input?.close().catch(() => undefined);
      }
    },
    async remove(ref) {
      const resolved = await resolve(ref);
      if (!resolved.rel) throw new Error('cannot remove an approved root');
      writable(resolved.root);
      await ensureAncestors(resolved.root, path.dirname(resolved.path));
      const st = await lstat(resolved.path);
      if (st.isDirectory()) await fsp.rmdir(resolved.path);
      else if (st.isFile()) await fsp.unlink(resolved.path);
      else throw new Error('only files and empty directories may be removed');
    },
    async watch(ref, onChange) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root, resolved.path);
      check();
      let closed = false;
      let timer: NodeJS.Timeout | undefined;
      let pending = false;
      let unsubscribe: () => void = () => undefined;
      const eventRef = (name?: string): FileRef => ({
        root: resolved.root.id,
        rel: name ? path.posix.join(resolved.rel, name) : resolved.rel,
      });
      const watcher = watch(
        resolved.path,
        { persistent: false },
        (nativeEvent, filename) => {
          if (closed || disposed || pending) return;
          pending = true;
          const name = filename?.toString();
          timer = setTimeout(() => {
            pending = false;
            if (closed || disposed) return;
            void options.roots
              .resolve(options.pluginId, resolved.root.id)
              .then(async () => {
                if (closed || disposed) return;
                let kind: FileChange['kind'] = 'changed';
                if (nativeEvent === 'rename' && name) {
                  try {
                    await lstat(path.join(resolved.path, name));
                  } catch {
                    kind = 'removed';
                  }
                }
                const event: FileChange = { ref: eventRef(name), kind };
                options.emit?.(event);
                onChange(event);
              })
              .catch(() => undefined);
          }, 20);
        },
      );
      const closeWatcher = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        watchers.delete(watcher);
        watcher.close();
        unsubscribe();
      };
      watcher.on('error', () => {
        if (closed) return;
        closeWatcher();
        const event: FileChange = { ref: eventRef(), kind: 'rescan' };
        options.emit?.(event);
        onChange(event);
      });
      watchers.add(watcher);
      unsubscribe = options.roots.subscribe(
        options.pluginId,
        options.owner,
        resolved.root.id,
        closeWatcher,
      );
      watcherCleanups.add(unsubscribe);
      return {
        async close() {
          if (!closed) {
            closeWatcher();
            watcherCleanups.delete(unsubscribe);
          }
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (abortListener && options.signal)
        options.signal.removeEventListener('abort', abortListener);
      for (const watcher of watchers) watcher.close();
      watchers.clear();
      for (const cleanup of watcherCleanups) cleanup();
      watcherCleanups.clear();
      cursors.clear();
      for (const value of handles.values())
        await value.file.close().catch(() => undefined);
      handles.clear();
    },
  };
  if (options.signal) {
    abortListener = () => {
      void service.dispose();
    };
    if (options.signal.aborted) void service.dispose();
    else
      options.signal.addEventListener('abort', abortListener, { once: true });
  }
  return service;
}
