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
    owner: string,
    rootPath: string,
    options: {
      name: string;
      writable: boolean;
      id?: string;
      identity?: { dev: string; ino: string };
    },
  ): Promise<FileRoot>;
  revoke(owner: string, id: string): Promise<void>;
  resolve(owner: string, id: string): Promise<FileRootGrant>;
  roots(owner: string): Promise<FileRoot[]>;
  subscribe(owner: string, id: string, onRevoke: () => void): () => void;
}

function opaqueId(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createFileRootRegistry(): FileRootRegistry {
  const grants = new Map<string, Map<string, FileRootGrant>>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    async grant(owner, rootPath, options) {
      const absolute = path.resolve(rootPath);
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('file root must be a directory');
      if (
        options.identity &&
        (String(stat.dev) !== options.identity.dev ||
          String(stat.ino) !== options.identity.ino)
      )
        throw new Error('persisted file root identity changed');
      const id = options.id ?? opaqueId();
      const grant = {
        id,
        name: options.name,
        writable: options.writable,
        path: await fsp.realpath(absolute),
        dev: String(stat.dev),
        ino: String(stat.ino),
      };
      let ownerGrants = grants.get(owner);
      if (!ownerGrants) {
        ownerGrants = new Map();
        grants.set(owner, ownerGrants);
      }
      ownerGrants.set(id, grant);
      return { id: grant.id, name: grant.name, writable: grant.writable };
    },
    async revoke(owner, id) {
      grants.get(owner)?.delete(id);
      const key = `${owner}\0${id}`;
      const callbacks = listeners.get(key);
      listeners.delete(key);
      for (const callback of callbacks ?? []) callback();
    },
    async resolve(owner, id) {
      const grant = grants.get(owner)?.get(id);
      if (!grant) throw new Error(`file root ${id} is unknown or revoked`);
      return { ...grant };
    },
    async roots(owner) {
      return [...(grants.get(owner)?.values() ?? [])].map(
        ({ path: _path, dev: _dev, ino: _ino, ...root }) => root,
      );
    },
    subscribe(owner, id, onRevoke) {
      const key = `${owner}\0${id}`;
      let callbacks = listeners.get(key);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(key, callbacks);
      }
      callbacks.add(onRevoke);
      return () => {
        callbacks?.delete(onRevoke);
        if (callbacks?.size === 0) listeners.delete(key);
      };
    },
  };
}
