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
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

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

export interface ScopedFilesOptions {
  owner: string;
  roots: FileRootRegistry;
  signal?: AbortSignal;
  emit?: (event: FileChange) => void;
  log?: (message: string) => void;
}

function validateRel(rel: string): string {
  if (rel.includes('\0')) throw new Error('path contains NUL');
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^\\\\/.test(rel))
    throw new Error('absolute paths are not allowed');
  if (/^[A-Za-z]:/.test(rel)) throw new Error('drive paths are not allowed');
  const normalized = rel.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) throw new Error('path traversal is not allowed');
  return parts.join('/');
}

function info(stat: fs.Stats | fs.BigIntStats): FileInfo {
  let kind: FileInfo['kind'] = 'other';
  if (stat.isFile()) kind = 'file';
  else if (stat.isDirectory()) kind = 'directory';
  return {
    kind,
    size: Number(stat.size),
    mtimeMs: 'mtimeNs' in stat ? Number(stat.mtimeNs) / 1e6 : Number(stat.mtimeMs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: Number(stat.nlink),
    mode: Number(stat.mode),
    symbolicLink: stat.isSymbolicLink(),
  };
}

function under(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function createScopedFiles(options: ScopedFilesOptions): ScopedFiles & { dispose(): Promise<void> } {
  const incarnation = randomUUID();
  const handles = new Map<string, { file: fs.promises.FileHandle; rootId: string; path: string; mode: 'r' | 'wx' }>();
  const watchers = new Set<fs.FSWatcher>();
  let disposed = false;
  let abortListener: (() => void) | undefined;

  const check = () => {
    if (disposed) throw new Error('scoped files service is disposed');
    if (options.signal?.aborted) throw new Error('scoped files service is aborted');
  };

  const resolve = async (ref: FileRef): Promise<{ root: Root; path: string; rel: string }> => {
    check();
    const root = await options.roots.resolve(options.owner, ref.root);
    const rel = validateRel(ref.rel);
    const target = path.resolve(root.path, ...rel ? rel.split('/') : []);
    if (!under(root.path, target)) throw new Error('path escapes file root');
    return { root, path: target, rel };
  };

  const ensureAncestors = async (rootPath: string, target: string) => {
    if (!under(rootPath, target)) throw new Error('path escapes file root');
    const rootStat = await fsp.lstat(rootPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('approved root changed');
    const rel = path.relative(rootPath, target);
    let current = rootPath;
    for (const segment of rel ? rel.split(path.sep) : []) {
      current = path.join(current, segment);
      try {
        const st = await fsp.lstat(current);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('symlink or non-directory ancestor');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
  };

  const writable = (root: Root) => {
    if (!root.writable) throw new Error('file root is read-only');
  };

  const checkedStat = async (target: string, follow: boolean): Promise<FileInfo> => {
    const st = follow ? await fsp.stat(target, { bigint: true }) : await fsp.lstat(target, { bigint: true });
    return info(st);
  };

  const getHandle = async (handle: ScopedFileHandle) => {
    check();
    const value = handles.get(handle.id);
    if (!value || !handle.id.startsWith(`${incarnation}:`)) throw new Error('invalid or closed file handle');
    try {
      await options.roots.resolve(options.owner, value.rootId);
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
      return options.roots.roots(options.owner);
    },
    async stat(ref) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      const final = await fsp.lstat(resolved.path);
      if (final.isSymbolicLink()) throw new Error('symlink targets are not allowed');
      return checkedStat(resolved.path, true);
    },
    async lstat(ref) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      return checkedStat(resolved.path, false);
    },
    async canonical(ref) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      const canonical = await fsp.realpath(resolved.path);
      if (!under(resolved.root.path, canonical)) throw new Error('canonical path escapes file root');
      return { root: resolved.root.id, rel: path.relative(resolved.root.path, canonical).split(path.sep).join('/') };
    },
    async mkdir(ref) {
      const resolved = await resolve(ref);
      writable(resolved.root);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      await fsp.mkdir(resolved.path);
    },
    async open(ref, mode) {
      if (mode !== 'r' && mode !== 'wx') throw new Error('invalid file open mode');
      const resolved = await resolve(ref);
      if (mode === 'wx') writable(resolved.root);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      if (mode === 'r' && (await fsp.lstat(resolved.path)).isSymbolicLink()) throw new Error('symlink targets are not allowed');
      const file = await fsp.open(resolved.path, mode === 'r' ? fs.constants.O_RDONLY | NOFOLLOW : 'wx');
      check();
      const id = `${incarnation}:${randomUUID()}`;
      handles.set(id, { file, rootId: resolved.root.id, path: resolved.path, mode });
      return { id };
    },
    async fstat(handle) {
      return info(await (await getHandle(handle)).file.stat({ bigint: true }));
    },
    async readHandle(handle, readOptions) {
      if (!Number.isSafeInteger(readOptions.offset) || readOptions.offset < 0 || !Number.isSafeInteger(readOptions.maxBytes) || readOptions.maxBytes < 0 || readOptions.maxBytes > MAX_BYTES)
        throw new Error('invalid or oversized read');
      const value = await getHandle(handle);
      const buffer = Buffer.allocUnsafe(readOptions.maxBytes);
      const result = await value.file.read(buffer, 0, readOptions.maxBytes, readOptions.offset);
      return new Uint8Array(buffer.subarray(0, result.bytesRead));
    },
    async writeHandle(handle, data) {
      if (data.byteLength > MAX_BYTES) throw new Error('write exceeds 16 MiB limit');
      const value = await getHandle(handle);
      if (value.mode !== 'wx') throw new Error('read-only handle');
      const root = await options.roots.resolve(options.owner, value.rootId);
      writable(root);
      let offset = 0;
      while (offset < data.byteLength) {
        const result = await value.file.write(data, offset, data.byteLength - offset);
        offset += result.bytesWritten;
      }
    },
    async syncHandle(handle) {
      await (await getHandle(handle)).file.sync();
    },
    async setHandleMetadata(handle, metadata) {
      const value = await getHandle(handle);
      if (value.mode !== 'wx') throw new Error('read-only handle');
      const root = await options.roots.resolve(options.owner, value.rootId);
      writable(root);
      if (metadata.mode !== undefined) await value.file.chmod(metadata.mode);
      if (metadata.atimeMs !== undefined || metadata.mtimeMs !== undefined) {
        const st = await value.file.stat();
        await value.file.utimes(metadata.atimeMs ?? st.atimeMs, metadata.mtimeMs ?? st.mtimeMs);
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
      await ensureAncestors(source.root.path, path.dirname(source.path));
      await ensureAncestors(destination.root.path, path.dirname(destination.path));
      await fsp.link(source.path, destination.path);
    },
    async list(ref, listOptions = {}) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root.path, resolved.path);
      const limit = Math.min(Math.max(listOptions.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
      const entries = await fsp.readdir(resolved.path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const cursor = listOptions.cursor ? Number.parseInt(Buffer.from(listOptions.cursor, 'base64url').toString(), 10) : 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entries.length) throw new Error('invalid cursor');
      const page = entries.slice(cursor, cursor + limit);
      const result: { entries: FileEntry[]; nextCursor?: string } = { entries: [] };
      for (const entry of page) {
        const entryInfo = await checkedStat(path.join(resolved.path, entry.name), false);
        result.entries.push({ name: entry.name, ...entryInfo });
      }
      if (cursor + page.length < entries.length) result.nextCursor = Buffer.from(String(cursor + page.length)).toString('base64url');
      return result;
    },
    async read(ref, readOptions = {}) {
      const offset = readOptions.offset ?? 0;
      const maxBytes = readOptions.maxBytes ?? MAX_BYTES;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES) throw new Error('invalid or oversized read');
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      if ((await fsp.lstat(resolved.path)).isSymbolicLink()) throw new Error('symlink targets are not allowed');
      const file = await fsp.open(resolved.path, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const result = await file.read(buffer, 0, maxBytes, offset);
        return new Uint8Array(buffer.subarray(0, result.bytesRead));
      } finally {
        await file.close();
      }
    },
    async write(ref, data, writeOptions = {}) {
      if (data.byteLength > MAX_BYTES) throw new Error('write exceeds 16 MiB limit');
      const resolved = await resolve(ref);
      writable(resolved.root);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      if (!writeOptions.ifAbsent) {
        try {
          if ((await fsp.lstat(resolved.path)).isSymbolicLink()) throw new Error('symlink targets are not allowed');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const file = await fsp.open(resolved.path, writeOptions.ifAbsent ? 'wx' : 'w');
      try {
        let offset = 0;
        while (offset < data.byteLength) {
          const result = await file.write(data, offset, data.byteLength - offset);
          offset += result.bytesWritten;
        }
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
      await ensureAncestors(source.root.path, path.dirname(source.path));
      await ensureAncestors(destination.root.path, path.dirname(destination.path));
      const sourceInfo = await fsp.lstat(source.path);
      if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error('move requires a regular file');
      const sourceDigest = createHash('sha256');
      const input = await fsp.open(source.path, fs.constants.O_RDONLY | NOFOLLOW);
      let output: fs.promises.FileHandle;
      try {
        output = await fsp.open(destination.path, 'wx');
      } catch (error) {
        await input.close();
        throw error;
      }
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        for (;;) {
          const result = await input.read(buffer, 0, buffer.length, position);
          if (result.bytesRead === 0) break;
          sourceDigest.update(buffer.subarray(0, result.bytesRead));
          let written = 0;
          while (written < result.bytesRead) {
            const out = await output.write(buffer, written, result.bytesRead - written);
            written += out.bytesWritten;
          }
          position += result.bytesRead;
        }
        await output.sync();
        await output.chmod(sourceInfo.mode);
        await output.utimes(sourceInfo.atimeMs, sourceInfo.mtimeMs);
      } catch (error) {
        await fsp.unlink(destination.path).catch(() => undefined);
        throw error;
      } finally {
        await input.close();
        await output.close();
      }
      let current: fs.Stats;
      let currentDigest: string;
      try {
        current = await fsp.lstat(source.path);
        currentDigest = await digestFile(source.path);
      } catch (error) {
        await fsp.unlink(destination.path).catch(() => undefined);
        throw error;
      }
      if (String(current.dev) !== String(sourceInfo.dev) || String(current.ino) !== String(sourceInfo.ino) || current.size !== sourceInfo.size || current.mtimeMs !== sourceInfo.mtimeMs || sourceDigest.digest('hex') !== currentDigest) {
        await fsp.unlink(destination.path).catch(() => undefined);
        throw new Error('source changed during move');
      }
      await fsp.unlink(source.path);
    },
    async remove(ref) {
      const resolved = await resolve(ref);
      if (!resolved.rel) throw new Error('cannot remove an approved root');
      writable(resolved.root);
      await ensureAncestors(resolved.root.path, path.dirname(resolved.path));
      const st = await fsp.lstat(resolved.path);
      if (st.isDirectory()) await fsp.rmdir(resolved.path);
      else if (st.isFile()) await fsp.unlink(resolved.path);
      else throw new Error('only files and empty directories may be removed');
    },
    async watch(ref, onChange) {
      const resolved = await resolve(ref);
      await ensureAncestors(resolved.root.path, resolved.path);
      let closed = false;
      let timer: NodeJS.Timeout | undefined;
      let pending = false;
      const eventRef = (name?: string): FileRef => ({ root: resolved.root.id, rel: name ? path.posix.join(resolved.rel, name) : resolved.rel });
      const watcher = fs.watch(resolved.path, { persistent: false }, (_event, filename) => {
        if (closed || disposed || pending) return;
        pending = true;
        const name = filename?.toString();
        timer = setTimeout(() => {
          pending = false;
          if (closed || disposed) return;
          void options.roots.resolve(options.owner, resolved.root.id).then(() => {
            if (closed || disposed) return;
            const event: FileChange = { ref: eventRef(name), kind: 'changed' };
            options.emit?.(event);
            onChange(event);
          }).catch(() => undefined);
        }, 20);
      });
      watchers.add(watcher);
      return {
        async close() {
          if (!closed) {
            closed = true;
            watchers.delete(watcher);
            if (timer) clearTimeout(timer);
            watcher.close();
          }
        },
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (abortListener && options.signal) options.signal.removeEventListener('abort', abortListener);
      for (const watcher of watchers) watcher.close();
      watchers.clear();
      for (const value of handles.values()) await value.file.close().catch(() => undefined);
      handles.clear();
    },
  };
  if (options.signal) {
    abortListener = () => { void service.dispose(); };
    if (options.signal.aborted) void service.dispose();
    else options.signal.addEventListener('abort', abortListener, { once: true });
  }
  return service;
}
