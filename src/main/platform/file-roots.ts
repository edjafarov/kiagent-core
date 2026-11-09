import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileRoot } from '@shared/plugin-files';

export interface FileRootGrant extends FileRoot {
  path: string;
  dev: string;
  ino: string;
}

export interface FileRootRegistry {
  grant(
    pluginId: string,
    rootPath: string,
    options: {
      name: string;
      writable: boolean;
      id?: string;
      identity?: { dev: string; ino: string };
    },
  ): Promise<FileRoot>;
  revoke(pluginId: string, id: string): Promise<void>;
  resolve(pluginId: string, id: string): Promise<FileRootGrant>;
  roots(pluginId: string): Promise<FileRoot[]>;
  subscribe(
    pluginId: string,
    activationOwner: string,
    id: string,
    onRevoke: () => void,
  ): () => void;
  snapshot(): PersistedFileRoot[];
  restore(
    records: readonly (PersistedFileRoot | LegacyPersistedFileRoot)[],
  ): Promise<void>;
}

export async function restoreFileRootsFromFile(
  filePath: string,
  registry: FileRootRegistry,
  onError: (error: unknown) => void = () => undefined,
): Promise<void> {
  try {
    const records = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    if (Array.isArray(records)) await registry.restore(records);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') onError(error);
  }
}

export function createFileRootsPersistence(
  filePath: string,
  registry: FileRootRegistry,
): () => Promise<void> {
  let write = Promise.resolve();
  return async () => {
    // Chain on a recovered promise: one failed write must never poison every
    // later save (bundled grants and declared roots share this writer).
    write = write
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${filePath}.${process.pid}.tmp`;
        await fsp.writeFile(
          temporary,
          JSON.stringify(registry.snapshot(), null, 2),
        );
        await fsp.rename(temporary, filePath);
      });
    await write;
  };
}

export interface PersistedFileRoot {
  pluginId: string;
  id: string;
  name: string;
  writable: boolean;
  path: string;
  dev: string;
  ino: string;
}

interface LegacyPersistedFileRoot extends Omit<PersistedFileRoot, 'pluginId'> {
  owner: string;
}

function opaqueId(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Whether a directory is the one a persisted grant recorded. The inode must
 *  match. The device number may differ only when the path is already
 *  canonical: macOS renumbers volumes across reboots (the same Data volume
 *  came back as a different st_dev), so a device change alone is not a
 *  replacement, while a path resolved through a symlink could reach another
 *  volume whose inode happens to match. */
function sameIdentity(
  stat: { dev: bigint; ino: bigint },
  identity: { dev: string; ino: string },
  absolute: string,
  canonical: string,
): boolean {
  if (String(stat.ino) !== identity.ino) return false;
  return String(stat.dev) === identity.dev || canonical === absolute;
}

export function createFileRootRegistry(): FileRootRegistry {
  const grants = new Map<string, Map<string, FileRootGrant>>();
  const listeners = new Map<string, Map<string, Set<() => void>>>();
  return {
    async grant(pluginId, rootPath, options) {
      const absolute = path.resolve(rootPath);
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('file root must be a directory');
      const canonical = await fsp.realpath(absolute);
      if (
        options.identity &&
        !sameIdentity(stat, options.identity, absolute, canonical)
      )
        throw new Error('persisted file root identity changed');
      const id = options.id ?? opaqueId();
      const grant = {
        id,
        name: options.name,
        writable: options.writable,
        path: canonical,
        dev: String(stat.dev),
        ino: String(stat.ino),
      };
      let pluginGrants = grants.get(pluginId);
      if (!pluginGrants) {
        pluginGrants = new Map();
        grants.set(pluginId, pluginGrants);
      }
      pluginGrants.set(id, grant);
      return { id: grant.id, name: grant.name, writable: grant.writable };
    },
    async revoke(pluginId, id) {
      grants.get(pluginId)?.delete(id);
      const key = `${pluginId}\0${id}`;
      const callbacks = listeners.get(key);
      listeners.delete(key);
      for (const activationCallbacks of callbacks?.values() ?? [])
        for (const callback of activationCallbacks) callback();
    },
    async resolve(pluginId, id) {
      const grant = grants.get(pluginId)?.get(id);
      if (!grant) throw new Error(`file root ${id} is unknown or revoked`);
      return { ...grant };
    },
    async roots(pluginId) {
      return [...(grants.get(pluginId)?.values() ?? [])].map(
        ({ path: _path, dev: _dev, ino: _ino, ...root }) => root,
      );
    },
    subscribe(pluginId, activationOwner, id, onRevoke) {
      if (!grants.get(pluginId)?.has(id)) {
        onRevoke();
        return () => undefined;
      }
      const key = `${pluginId}\0${id}`;
      let activationCallbacks = listeners.get(key);
      if (!activationCallbacks) {
        activationCallbacks = new Map();
        listeners.set(key, activationCallbacks);
      }
      let callbacks = activationCallbacks.get(activationOwner);
      if (!callbacks) {
        callbacks = new Set();
        activationCallbacks.set(activationOwner, callbacks);
      }
      callbacks.add(onRevoke);
      return () => {
        callbacks?.delete(onRevoke);
        if (callbacks?.size === 0) activationCallbacks?.delete(activationOwner);
        if (activationCallbacks?.size === 0) listeners.delete(key);
      };
    },
    snapshot() {
      return [...grants.entries()].flatMap(([pluginId, pluginGrants]) =>
        [...pluginGrants.values()].map((grant) => ({ pluginId, ...grant })),
      );
    },
    async restore(records) {
      for (const record of records) {
        try {
          const pluginId =
            'pluginId' in record ? record.pluginId : record.owner;
          await this.grant(pluginId, record.path, {
            id: record.id,
            name: record.name,
            writable: record.writable,
            identity: { dev: record.dev, ino: record.ino },
          });
        } catch {
          // A missing/replaced path is not re-approved. The record remains
          // absent until the trusted main-process channel grants it again.
        }
      }
    },
  };
}
