import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileRoot } from '@shared/plugin-files';

export interface FileRootGrant extends FileRoot {
  path: string;
}

export interface FileRootRegistry {
  grant(owner: string, rootPath: string, options: { name: string; writable: boolean; id?: string }): Promise<FileRoot>;
  revoke(owner: string, id: string): Promise<void>;
  resolve(owner: string, id: string): Promise<FileRootGrant>;
  roots(owner: string): Promise<FileRoot[]>;
}

function opaqueId(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createFileRootRegistry(): FileRootRegistry {
  const grants = new Map<string, Map<string, FileRootGrant>>();
  return {
    async grant(owner, rootPath, options) {
      const absolute = path.resolve(rootPath);
      const stat = await fsp.lstat(absolute);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('file root must be a directory');
      const id = options.id ?? opaqueId();
      const grant = { id, name: options.name, writable: options.writable, path: await fsp.realpath(absolute) };
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
    },
    async resolve(owner, id) {
      const grant = grants.get(owner)?.get(id);
      if (!grant) throw new Error(`file root ${id} is unknown or revoked`);
      return { ...grant };
    },
    async roots(owner) {
      return [...(grants.get(owner)?.values() ?? [])].map(({ path: _path, ...root }) => root);
    },
  };
}
