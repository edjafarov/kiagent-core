/** The `shared-folder` source: one account for the whole user account, run on
 *  the leader only (it is not device-owned), whose documents travel to the
 *  copies. Its listing is the manifest (`shared_files`); the disk is read only
 *  to parse the bytes of a row that is present here. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  AuthChannel,
  Batch,
  Document,
  ExternalRef,
  Session,
  Source,
  SourceDescriptor,
} from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { sha256File } from '../../core/shared-folders/hash';
import { safeAbs, type SharedRoot } from '../../core/shared-folders/paths';
import type { SharedFoldersApi } from '../../core/shared-folders/service';
import { decideLocalFile } from '../local-folder/ingestible';
import { resolvePathMime } from '../local-folder/mime';
import { buildItem } from '../local-folder/scanner';
import type { LocalFileItem } from '../local-folder/to-document';
import { sharedExternalId, toDocument, type SharedFileItem } from './to-document';

export const SHARED_SOURCE_ID = 'shared-folder';
/** The one account's fixed identifier. */
export const SHARED_IDENTIFIER = 'shared';

export const descriptor: SourceDescriptor = {
  id: SHARED_SOURCE_ID,
  name: 'Shared folders',
  documentTypes: ['file'],
  auth: 'none',
  multiAccount: false,
  cadence: { every: '30m' },
};

/** What the source needs from the host; absent until the host has built it. */
export interface SharedFolderHost {
  db: AppDb;
  sharedFolders: Pick<SharedFoldersApi, 'roots' | 'pathOf' | 'onChange' | 'usable' | 'reportUnparsed' | 'enabled'>;
}

/** `rev` is the highest manifest revision handled. `roots` are the roots that
 *  were set while it advanced: a root set later starts the listing again,
 *  because rows of an unset root were passed over. */
export interface SharedFolderCursor {
  rev: number;
  roots?: SharedRoot[];
}

const PAGE = 50;

interface Row {
  root: SharedRoot;
  rel_path: string;
  sha256: string;
  bytes: number;
  mtime: string;
  missing_here: number;
  deleted: number;
  rev: number;
}

const rootsSet = (host: SharedFolderHost): SharedRoot[] => {
  const r = host.sharedFolders.roots();
  // A root that is owed its reconcile counts as not set: its rows are passed
  // over, and the listing starts again from the top when it becomes usable.
  return (['incoming', 'sorted'] as const).filter((k) => r[k] && host.sharedFolders.usable(k));
};

/** The item for a present, live row, or null when the file is not readable
 *  here or changed while it was read (the scan will list the change). */
/** The manifest's live row for this file that this Mac holds the bytes of
 *  (not `missing_here`): the version the leader publishes. */
async function currentSha(host: SharedFolderHost, root: string, rel: string): Promise<string | null> {
  const row = (await host.db.all(`SELECT sha256, deleted, missing_here FROM shared_files WHERE root = ? AND rel_path = ?`, [
    root,
    rel,
  ]))[0];
  return !row || row.deleted || row.missing_here ? null : String(row.sha256);
}

async function itemFor(host: SharedFolderHost, row: Row, base: string): Promise<SharedFileItem | null> {
  const current = await currentSha(host, row.root, row.rel_path);
  if (current === null) return null;
  let abs: string;
  try {
    abs = await safeAbs(base, row.rel_path);
  } catch {
    return null;
  }
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(abs);
  } catch {
    return null;
  }
  if (!before.isFile()) return null;
  // The hash of the bytes parsed: the manifest's stat cache when the file is
  // as the scan saw it, else a fresh hash. Checked again after the read.
  const m = (await host.db.all(`SELECT sha256, bytes, mtime_ms FROM shared_mirror WHERE root = ? AND rel_path = ?`, [
    row.root,
    row.rel_path,
  ]))[0];
  let sha: string;
  if (m && Number(m.bytes) === before.size && Number(m.mtime_ms) === Math.floor(before.mtimeMs)) sha = String(m.sha256);
  else {
    try {
      sha = await sha256File(abs);
    } catch {
      return null;
    }
  }
  // Older (or newer) bytes than the row names are not the current file.
  if (sha !== current) return null;
  const built = await buildItem(abs, before);
  let after: fs.Stats;
  try {
    after = await fs.promises.lstat(abs);
  } catch {
    return null;
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
  let file: LocalFileItem;
  if (built && !('container' in built)) file = built;
  else if (built) {
    // A mailbox, archive or the like: not expanded here, but findable by name.
    file = {
      absPath: abs,
      externalId: abs,
      size: before.size,
      mtimeIso: before.mtime.toISOString(),
      createdIso: (before.birthtime.getTime() > 0 ? before.birthtime : before.mtime).toISOString(),
      ext: path.extname(abs).slice(1).toLowerCase(),
      mime: resolvePathMime(abs),
      markdownText: null,
      binary: null,
    };
  } else return null;
  return { file, root: row.root, relPath: row.rel_path, sha256: sha };
}

export function createSharedFolderSource(
  host: () => SharedFolderHost | null,
): Source<SharedFolderCursor, SharedFileItem> {
  async function* pull(
    session: Session,
    cursor: SharedFolderCursor | null,
  ): AsyncIterable<Batch<SharedFolderCursor, SharedFileItem>> {
    const h = host();
    if (!h || !h.sharedFolders.enabled()) return; // nothing is shared on this device
    const live = session.account.config?.watch !== false;
    let wake: (() => void) | null = null;
    let dirty = false; // a change that arrived while rows were being handled
    const off = live
      ? h.sharedFolders.onChange(() => {
          dirty = true;
          wake?.();
        })
      : () => {};
    try {
      for (;;) {
        dirty = false;
        const set = rootsSet(h);
        let cur = cursor;
        if (cur && (cur.roots ?? []).join() !== set.join()) cur = null; // a root appeared or went: list again
        let rev = cur?.rev ?? 0;
        const total = Number(
          (await h.db.all(`SELECT count(*) AS n FROM shared_files WHERE rev > ?`, [rev]))[0]?.n ?? 0,
        );
        let first = true;
        for (;;) {
          if (session.signal.aborted) return;
          // eslint-disable-next-line no-await-in-loop
          const rows = (await h.db.all(
            `SELECT root, rel_path, sha256, bytes, mtime, missing_here, deleted, rev
               FROM shared_files WHERE rev > ? ORDER BY rev LIMIT ?`,
            [rev, PAGE],
          )) as unknown as Row[];
          if (rows.length === 0 && !first) break;
          const items: SharedFileItem[] = [];
          const deletions: ExternalRef[] = [];
          const unparsed: { root: SharedRoot; relPath: string }[] = [];
          for (const row of rows) {
            if (row.deleted) deletions.push({ externalId: sharedExternalId(row.root, row.rel_path), type: 'file' });
            else if (!row.missing_here) {
              const base = set.includes(row.root) ? h.sharedFolders.roots()[row.root] : null;
              // eslint-disable-next-line no-await-in-loop
              const item = base ? await itemFor(h, row, base) : null;
              if (item) items.push(item);
              else if (base) {
                // The cursor moves past this row: the service gives it a new
                // revision when the file can be read, so it is not lost.
                unparsed.push({ root: row.root, relPath: row.rel_path });
                session.log('info', `${row.root}/${row.rel_path} is not readable here yet; it is listed again when it can be`);
              }
            }
          }
          if (unparsed.length) await h.sharedFolders.reportUnparsed(unparsed);
          if (rows.length) rev = rows[rows.length - 1].rev;
          first = false;
          const done = rows.length < PAGE;
          yield {
            phase: done ? 'live' : 'backfill',
            items,
            deletions,
            cursor: { rev, roots: set },
            estimateTotal: total,
          };
          if (done) break;
        }
        cursor = { rev, roots: set };
        if (!live) return;
        if (dirty) continue;
        // Wait for the manifest to change (or the pull to be cancelled).
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            session.signal.removeEventListener('abort', stop);
            wake = null;
            resolve();
          };
          wake = stop;
          session.signal.addEventListener('abort', stop, { once: true });
        });
        if (session.signal.aborted) return;
      }
    } finally {
      off();
    }
  }

  async function* reconcile(session: Session): AsyncIterable<ExternalRef[]> {
    const h = host();
    if (!h) return;
    let after = '';
    for (;;) {
      if (session.signal.aborted) return;
      // eslint-disable-next-line no-await-in-loop
      const rows = (await h.db.all(
        `SELECT root, rel_path FROM shared_files WHERE deleted = 0 AND root || '/' || rel_path > ?
          ORDER BY root || '/' || rel_path LIMIT 500`,
        [after],
      )) as unknown as { root: string; rel_path: string }[];
      if (rows.length === 0) return;
      const refs = rows.map((r): ExternalRef => ({ externalId: sharedExternalId(r.root, r.rel_path), type: 'file' }));
      after = refs[refs.length - 1].externalId;
      yield refs;
    }
  }

  return {
    descriptor,
    connect: async (_auth: AuthChannel) => ({ identifier: SHARED_IDENTIFIER, config: {} }),
    pull,
    toDocument,
    reconcile,
    async fetchBytes(_session: Session, doc: Document): Promise<Uint8Array | null> {
      const h = host();
      if (!h) return null;
      const abs = await h.sharedFolders.pathOf({ accountId: doc.accountId, externalId: doc.externalId });
      if (!abs) return null;
      const root = doc.externalId.slice(0, doc.externalId.indexOf('/'));
      if ((root === 'incoming' || root === 'sorted') && !h.sharedFolders.usable(root)) return null;
      try {
        const rel = doc.externalId.slice(doc.externalId.indexOf('/') + 1);
        const current = await currentSha(h, root, rel);
        const st = await fs.promises.stat(abs);
        const d = decideLocalFile(abs, st.size);
        if (d.kind === 'ignore' || d.bytes === 'none') return null;
        const bytes = new Uint8Array(await fs.promises.readFile(abs));
        // The bytes just read must be the version the row names.
        return createHash('sha256').update(bytes).digest('hex') === current ? bytes : null;
      } catch {
        return null;
      }
    },
  };
}
