/**
 * 3-phase installer (spec §4.2): LOCAL refs (absolute dir or .tgz — the dev
 * loop) plus marketplace refs (github:owner/repo[@tag] or an http(s) URL),
 * resolved via the injected `download` dep. preview stages + validates,
 * commit moves into userData/extensions/ and records installed.json.
 * Consent recording and activation belong to the extension platform, not
 * here. Marketplace installs are SRI/TOFU-pinned: `download` resolves a ref
 * to tarball bytes plus the pinned ref to record, and the first install of a
 * given id+version freezes its sha512 integrity hash — a later preview of
 * the same id+version with different bytes is rejected. Without a `download`
 * dep, marketplace refs are rejected up front, same as before Plan B.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as tar from 'tar';

import type { Manifest } from '@shared/contracts';

import {
  sourceContributions,
  validateManifestDir,
} from '@main/platform/manifest';
import { readInstalled, writeInstalled, type InstalledRecord } from '@main/platform/extensions';

const MAX_PENDING = 8;

export interface PendingInstall {
  token: string;
  stagingDir: string;
  manifest: Manifest;
  sizeBytes: number;
  integrity: string | null;
  ref: string;
  origin: 'marketplace' | 'dev';
}

export interface InstallerDeps {
  extDir: string;
  sourceIdOwners(): Record<string, string>;
  /** Resolves a marketplace ref (github:owner/repo[@tag] or http(s) URL) to
   *  tarball bytes + the PINNED ref to record. Absent → marketplace refs are
   *  rejected exactly as in Plan A. */
  download?: (ref: string) => Promise<{ bytes: Buffer; pinnedRef: string }>;
}

function duSync(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += duSync(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function createInstaller(deps: InstallerDeps) {
  const pending = new Map<string, PendingInstall>();

  const evict = (token: string) => {
    const p = pending.get(token);
    if (!p) return;
    pending.delete(token);
    fs.rmSync(p.stagingDir, { recursive: true, force: true });
  };

  return {
    async preview(ref: string): Promise<PendingInstall> {
      // Plaintext http: is rejected outright, not merely routed away from
      // the marketplace branch — TOFU integrity-pinning only protects
      // RE-installs (it compares against a prior pinned hash), so a first
      // install over http is MITM-able. Checked before the isMarketplace
      // test (which only recognizes github:/https:, per spec) so an http:
      // ref never falls through to the local-path branch and surfaces a
      // confusing "no such path" filesystem error instead of this one.
      if (/^http:/.test(ref)) {
        throw new Error('insecure http: refs are not supported — use an https: URL or a github: ref');
      }
      const isMarketplace = /^github:/.test(ref) || /^https:/.test(ref);
      if (isMarketplace && !deps.download) {
        throw new Error('marketplace installs are not available yet — install from a local path');
      }
      const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-ext-stage-'));
      try {
        let integrity: string | null = null;
        let recordRef: string;
        if (isMarketplace) {
          const { bytes, pinnedRef } = await deps.download!(ref);
          integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
          recordRef = pinnedRef;
          // Write + extract share one try/finally so the sibling .tgz in
          // os.tmpdir() is removed on every exit path — including a throw
          // from writeFileSync itself (e.g. disk-full mid-write), not just
          // from tar.x — rather than leaking a partial file.
          const tgzPath = `${stagingDir}.tgz`;
          try {
            fs.writeFileSync(tgzPath, bytes);
            await tar.x({ file: tgzPath, cwd: stagingDir, strip: 1 });
          } finally {
            fs.rmSync(tgzPath, { force: true });
          }
        } else {
          const abs = path.resolve(ref);
          if (!fs.existsSync(abs)) throw new Error(`no such path: ${ref}`);
          recordRef = `file:${abs}`;
          const stat = fs.statSync(abs);
          if (stat.isDirectory()) {
            fs.cpSync(abs, stagingDir, {
              recursive: true,
              filter: (src) => src !== path.join(abs, 'data'),
            });
          } else if (abs.endsWith('.tgz') || abs.endsWith('.tar.gz')) {
            await tar.x({ file: abs, cwd: stagingDir, strip: 1 });
          } else {
            throw new Error('local ref must be a directory or a .tgz');
          }
        }
        if (fs.existsSync(path.join(stagingDir, 'data'))) {
          throw new Error(
            "package ships a 'data/' directory — 'data/' is reserved for extension-private state",
          );
        }
        const { manifest } = validateManifestDir(stagingDir);
        const owners = deps.sourceIdOwners();
        for (const { id: sid } of sourceContributions(manifest)) {
          const owner = owners[sid];
          if (owner && owner !== manifest.id) {
            throw new Error(`source id '${sid}' is already provided by ${owner}`);
          }
        }
        if (integrity) {
          const prior = readInstalled(deps.extDir).find((r) => r.id === manifest.id);
          if (prior && prior.version === manifest.version && prior.integrity && prior.integrity !== integrity) {
            throw new Error('integrity check failed: bytes differ from the pinned install for this version');
          }
        }
        const entry: PendingInstall = {
          token: crypto.randomUUID(),
          stagingDir,
          manifest,
          sizeBytes: duSync(stagingDir),
          integrity,
          ref: recordRef,
          origin: isMarketplace ? 'marketplace' : 'dev',
        };
        pending.set(entry.token, entry);
        if (pending.size > MAX_PENDING) evict(pending.keys().next().value as string);
        return entry;
      } catch (e) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw e;
      }
    },

    /** Read-only: the pending manifest id for a token, without consuming
     *  it — lets a caller (installCommit) lock on the extension id BEFORE
     *  commit() touches disk. Throws the same error commit() would for an
     *  unknown/expired token. */
    peek(token: string): string {
      const p = pending.get(token);
      if (!p) throw new Error('unknown or expired install token — run preview again');
      return p.manifest.id;
    },

    async commit(token: string): Promise<{ manifest: Manifest; record: InstalledRecord; dir: string }> {
      const p = pending.get(token);
      if (!p) throw new Error('unknown or expired install token — run preview again');
      pending.delete(token);
      fs.mkdirSync(deps.extDir, { recursive: true });
      const dir = path.join(deps.extDir, p.manifest.id);
      let dataBackup: string | null = null;
      if (fs.existsSync(dir)) {
        const dataDir = path.join(dir, 'data');
        if (fs.existsSync(dataDir)) {
          dataBackup = `${dir}.data-backup`;
          fs.rmSync(dataBackup, { recursive: true, force: true });
          fs.renameSync(dataDir, dataBackup);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
      moveDir(p.stagingDir, dir);
      if (dataBackup) fs.renameSync(dataBackup, path.join(dir, 'data'));
      const record: InstalledRecord = {
        id: p.manifest.id,
        version: p.manifest.version,
        ref: p.ref,
        integrity: p.integrity,
        installedAt: new Date().toISOString(),
        origin: p.origin,
      };
      const records = readInstalled(deps.extDir).filter((r) => r.id !== record.id);
      writeInstalled(deps.extDir, [...records, record]);
      return { manifest: p.manifest, record, dir };
    },

    discardAll(): void {
      [...pending.keys()].forEach(evict);
    },
  };
}
