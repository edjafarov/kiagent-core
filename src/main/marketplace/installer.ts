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
  oauthSourceBindings,
  sourceContributions,
  validateManifestDir,
} from '@main/platform/manifest';
import { provenanceOf, STORE_OWNER } from '@shared/install-link';
import { parseGitHubRef } from './github-ref';
import {
  readInstalled,
  writeInstalled,
  type InstalledRecord,
} from '@main/platform/extensions';

const MAX_PENDING = 8;

/** Bounds on what one package may unpack to (spec §4). */
export const EXTRACT_LIMITS = { entries: 20_000, bytes: 512 * 1024 * 1024 };
export const TOO_LARGE = 'package is too large to install';
export const HAS_LINKS = 'package contains links, which aren’t allowed';
export const STORE_ONLY_OAUTH =
  'This connector asks to sign in through KIAgent’s own Google or Microsoft access, which only store connectors can use.';

export function differentPublisher(
  name: string,
  oldRepo: string,
  newRepo: string,
): string {
  return `${name} is already installed from ${oldRepo}. This one is from ${newRepo}, a different publisher, so KIAgent won’t replace it. To switch, remove ${name} in Settings › Extensions first.`;
}

export function bundledRefusal(id: string): string {
  return `'${id}' is bundled with the app and cannot be replaced from the marketplace`;
}

function repoOf(ref: string): string {
  const g = parseGitHubRef(ref.replace(/@.*$/, ''));
  return g ? `${g.owner}/${g.repo}` : ref;
}

/** Unpacks a .tgz (strip:1) within EXTRACT_LIMITS, refusing links. The
 *  moment a bound trips, the parse is aborted and the file stops being
 *  read — a highly compressible archive can't keep main inflating. */
function extractBounded(
  file: string,
  cwd: string,
  limits: { entries: number; bytes: number },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let entries = 0;
    let bytes = 0;
    let done = false;
    const src = fs.createReadStream(file);
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) {
        src.destroy();
        reject(err);
      } else resolve();
    };
    const unpack = tar.x({
      cwd,
      strip: 1,
      filter: (_p, entry) => {
        const e = entry as { type?: string; size?: number };
        let refuse: string | null = null;
        if (e.type === 'SymbolicLink' || e.type === 'Link') refuse = HAS_LINKS;
        else {
          entries += 1;
          bytes += e.size ?? 0;
          if (entries > limits.entries || bytes > limits.bytes)
            refuse = TOO_LARGE;
        }
        if (refuse) {
          const err = new Error(refuse);
          finish(err);
          (unpack as unknown as { abort(e: Error): void }).abort(err);
          return false;
        }
        return true;
      },
    });
    unpack.on('close', () => finish());
    unpack.on('error', (e: Error) => finish(e));
    src.on('error', (e) => finish(e));
    src.pipe(unpack as unknown as NodeJS.WritableStream);
  });
}

export interface PendingInstall {
  token: string;
  stagingDir: string;
  manifest: Manifest;
  sizeBytes: number;
  integrity: string | null;
  ref: string;
  origin: 'marketplace' | 'dev';
  /** GitHub's numeric repository id for a `github:` install, else null. */
  repoId: number | null;
}

export interface InstallerDeps {
  extDir: string;
  sourceIdOwners(): Record<string, string>;
  /** Ids of the extensions bundled with the app — never replaceable. */
  bundledIds?(): ReadonlySet<string>;
  /** Test seam for EXTRACT_LIMITS. */
  limits?: { entries: number; bytes: number };
  /** Resolves a marketplace ref (github:owner/repo[@tag] or http(s) URL) to
   *  tarball bytes + the PINNED ref to record. Absent → marketplace refs are
   *  rejected exactly as in Plan A. */
  download?: (
    ref: string,
  ) => Promise<{ bytes: Buffer; pinnedRef: string; repoId?: number }>;
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
  const limits = deps.limits ?? EXTRACT_LIMITS;

  /** Spec §3 — run at preview, again before the running extension is
   *  stopped (check), and once more inside commit. Reads only local state. */
  function guard(p: {
    manifest: Manifest;
    ref: string;
    origin: 'marketplace' | 'dev';
    repoId: number | null;
  }): void {
    const { manifest, ref } = p;
    if (deps.bundledIds?.().has(manifest.id))
      throw new Error(bundledRefusal(manifest.id));
    if (
      p.origin === 'marketplace' &&
      provenanceOf(ref).kind !== 'store' &&
      oauthSourceBindings(manifest).length > 0
    )
      throw new Error(STORE_ONLY_OAUTH);
    const prior = readInstalled(deps.extDir).find((r) => r.id === manifest.id);
    if (!prior?.ref.startsWith('github:') || ref.startsWith('file:')) return;
    const samePublisher =
      prior.repoId != null
        ? prior.repoId === p.repoId
        : ref.startsWith('github:') &&
          (parseGitHubRef(prior.ref)?.owner.toLowerCase() ?? '') ===
            STORE_OWNER &&
          repoOf(prior.ref).toLowerCase() === repoOf(ref).toLowerCase();
    if (!samePublisher)
      throw new Error(
        differentPublisher(manifest.name, repoOf(prior.ref), repoOf(ref)),
      );
  }

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
      // check, which only recognizes github:/https:, per spec, so an http:
      // ref never falls through to the local-path branch and surfaces a
      // confusing "no such path" filesystem error instead of this one.
      if (/^http:/.test(ref)) {
        throw new Error(
          'insecure http: refs are not supported — use an https: URL or a github: ref',
        );
      }
      const isMarketplace = /^github:/.test(ref) || /^https:/.test(ref);
      if (isMarketplace && !deps.download) {
        throw new Error(
          'marketplace installs are not available yet — install from a local path',
        );
      }
      const stagingDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'kia-ext-stage-'),
      );
      try {
        let integrity: string | null = null;
        let recordRef: string;
        let repoId: number | null = null;
        if (isMarketplace) {
          const { bytes, pinnedRef, repoId: rid } = await deps.download!(ref);
          repoId = rid ?? null;
          integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
          recordRef = pinnedRef;
          // Write + extract share one try/finally so the sibling .tgz in
          // os.tmpdir() is removed on every exit path — including a throw
          // from writeFileSync itself (e.g. disk-full mid-write), not just
          // from tar.x — rather than leaking a partial file.
          const tgzPath = `${stagingDir}.tgz`;
          try {
            fs.writeFileSync(tgzPath, bytes);
            await extractBounded(tgzPath, stagingDir, limits);
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
            await extractBounded(abs, stagingDir, limits);
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
            throw new Error(
              `source id '${sid}' is already provided by ${owner}`,
            );
          }
        }
        const origin = isMarketplace ? 'marketplace' : 'dev';
        guard({ manifest, ref: recordRef, origin, repoId });
        if (integrity) {
          const prior = readInstalled(deps.extDir).find(
            (r) => r.id === manifest.id,
          );
          if (
            prior &&
            prior.version === manifest.version &&
            prior.integrity &&
            prior.integrity !== integrity
          ) {
            throw new Error(
              'integrity check failed: bytes differ from the pinned install for this version',
            );
          }
        }
        const entry: PendingInstall = {
          token: crypto.randomUUID(),
          stagingDir,
          manifest,
          sizeBytes: duSync(stagingDir),
          integrity,
          ref: recordRef,
          origin,
          repoId,
        };
        pending.set(entry.token, entry);
        if (pending.size > MAX_PENDING)
          evict(pending.keys().next().value as string);
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
      if (!p)
        throw new Error('unknown or expired install token — run preview again');
      return p.manifest.id;
    },

    /** Read-only: the ref a pending install was staged from (a follower hands
     *  it to the leader instead of committing). */
    peekRef(token: string): {
      ref: string;
      origin: 'marketplace' | 'dev';
      integrity: string | null;
    } {
      const p = pending.get(token);
      if (!p)
        throw new Error('unknown or expired install token — run preview again');
      return { ref: p.ref, origin: p.origin, integrity: p.integrity };
    },

    /** The install guards for a staged package, without touching disk —
     *  run before the running extension is stopped, so a refusal leaves
     *  it running. Throws the refusal. */
    check(token: string): void {
      const p = pending.get(token);
      if (!p)
        throw new Error('unknown or expired install token — run preview again');
      guard(p);
    },

    /** Drops one staged install without committing it. */
    discard(token: string): void {
      evict(token);
    },

    async commit(
      token: string,
    ): Promise<{ manifest: Manifest; record: InstalledRecord; dir: string }> {
      const p = pending.get(token);
      if (!p)
        throw new Error('unknown or expired install token — run preview again');
      guard(p);
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
        ...(p.repoId != null ? { repoId: p.repoId } : {}),
      };
      const records = readInstalled(deps.extDir).filter(
        (r) => r.id !== record.id,
      );
      writeInstalled(deps.extDir, [...records, record]);
      return { manifest: p.manifest, record, dir };
    },

    discardAll(): void {
      [...pending.keys()].forEach(evict);
    },
  };
}
