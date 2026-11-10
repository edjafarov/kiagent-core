import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppDb } from '../../../../db/app-db';
import type { FileQuery, OfferAnswer, OfferMeta, SharedFoldersApi, SharedTransport } from '../../service';
import type { SharedRoot } from '../../paths';

type Serve = SharedFoldersApi['serve'];

export const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** A leader that is only a pair of folders: it holds whatever files are there
 *  and answers every offer with `answer`. Task 5's mirror tests use it; the
 *  two-Macs test uses the real service's `serve`. */
export function stubServe(
  roots: Record<SharedRoot, string>,
  answer: (meta: OfferMeta) => OfferAnswer = () => 'written',
): Serve & { offers: OfferMeta[]; removed: FileQuery[]; offered: Map<string, string> } {
  const offers: OfferMeta[] = [];
  const removed: FileQuery[] = [];
  const offered = new Map<string, string>();
  return {
    offers,
    removed,
    offered,
    open: async (q) => {
      const p = path.join(roots[q.root], ...q.relPath.split('/'));
      try {
        const b = fs.readFileSync(p);
        return sha(b) === q.sha256 ? { path: p, bytes: b.length } : null;
      } catch {
        return null;
      }
    },
    stagingFile: async (root) => {
      const dir = path.join(roots[root], '.kia-sync');
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, `in-${Math.random().toString(36).slice(2)}`);
    },
    offer: async (meta, tmp) => {
      offers.push(meta);
      offered.set(`${meta.root}/${meta.relPath}`, fs.readFileSync(tmp, 'utf8'));
      fs.rmSync(tmp, { force: true });
      return answer(meta);
    },
    remove: async (q) => {
      removed.push(q);
      return true;
    },
  };
}

export interface FakeTransport extends SharedTransport {
  /** Every call, in order: `fetch root/rel@offset`, `offer root/rel`, `remove root/rel`. */
  calls: string[];
  /** Runs inside `fetch` after the first `bytes` bytes were written (default: after all). */
  duringFetch?: (q: FileQuery) => void | Promise<void>;
  /** Written to `dest`, then the call throws: a connection that broke. */
  breakAfter?: number;
  /** Runs inside `offer`, before the leader answers. */
  duringOffer?: (meta: OfferMeta) => void | Promise<void>;
  /** Bytes served instead of the leader's (a corrupt transfer). */
  corrupt?: boolean;
  fail?: boolean;
}

/** A transport that calls the leader's `serve`, as the app's will over the network. */
export function serveTransport(leader: Serve, deviceName = 'Air'): FakeTransport {
  const t: FakeTransport = {
    calls: [],
    fetch: async (q, dest, offset) => {
      t.calls.push(`fetch ${q.root}/${q.relPath}@${offset}`);
      if (t.fail) throw new Error('offline');
      const open = await leader.open(q);
      if (!open) return 'gone';
      let bytes = fs.readFileSync(open.path).subarray(offset);
      if (t.corrupt) bytes = Buffer.from('garbage');
      if (t.breakAfter !== undefined) {
        fs.appendFileSync(dest, bytes.subarray(0, t.breakAfter));
        t.breakAfter = undefined;
        throw new Error('connection reset');
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.appendFileSync(dest, bytes);
      await t.duringFetch?.(q);
      return 'ok';
    },
    offer: async (meta, file) => {
      t.calls.push(`offer ${meta.root}/${meta.relPath}`);
      if (t.fail) throw new Error('offline');
      await t.duringOffer?.(meta);
      const tmp = await leader.stagingFile(meta.root);
      fs.copyFileSync(file, tmp);
      return leader.offer(meta, tmp, deviceName);
    },
    remove: async (q) => {
      t.calls.push(`remove ${q.root}/${q.relPath}`);
      if (t.fail) throw new Error('offline');
      await leader.remove(q);
    },
  };
  return t;
}

/** The sync service's job for the two copied tables: the copy's rows become the leader's. */
export async function copyRows(from: AppDb, to: AppDb): Promise<void> {
  for (const [table, cols] of [
    ['shared_files', 'root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev'],
    ['shared_capture_files', 'capture_id, sha256'],
  ] as const) {
    const rows = await from.all(`SELECT ${cols} FROM ${table}`);
    await to.run(`DELETE FROM ${table}`);
    const names = cols.split(', ');
    for (const r of rows)
      // eslint-disable-next-line no-await-in-loop
      await to.run(
        `INSERT INTO ${table}(${cols}) VALUES(${names.map(() => '?').join(',')})`,
        names.map((n) => r[n] as never),
      );
  }
}

export const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'shared-t-'));
