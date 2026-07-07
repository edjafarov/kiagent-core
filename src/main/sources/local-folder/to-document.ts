import path from 'node:path';

import type { DocumentInput } from '@shared/contracts';

/**
 * What `pull()` builds per file and hands to `toDocument`. This is the `Item`
 * half of `Source<Cursor, Item>` — everything is computed/read UP FRONT (fs
 * access only ever happens inside `pull()`) so `toDocument` can stay PURE and
 * synchronous, per the Source contract.
 */
export interface LocalFolderItem {
  /** Absolute path on disk. */
  absPath: string;
  /** ABSOLUTE posix-style path (`absPath.split(path.sep).join('/')`) — this
   *  IS the document's `externalId`. Widened from a root-relative path (the
   *  single-root scheme) to an absolute one so the same filename under two
   *  different configured roots never collides — see cursor.ts and
   *  watch.ts, which must agree on this same formula for deletions. */
  externalId: string;
  size: number;
  mtimeIso: string;
  createdIso: string;
  /** Lower-cased extension, no leading dot (`'pdf'`, `''` if none). */
  ext: string;
  /** Set for plain-text files — decoded utf-8 by `pull()` itself. */
  markdownText: string | null;
  /** Set for parseable binaries (pdf/docx/xlsx/csv/html) — `markdown` stays
   *  null on the resulting DocumentInput and the ENGINE converts. */
  binary: { bytes: Uint8Array; mime: string; filename: string } | null;
}

/**
 * PURE item → DocumentInput mapping (no fs access — everything the doc needs
 * was already read by `pull()`/`buildItem`).
 */
export function toDocument(item: LocalFolderItem): DocumentInput | null {
  return {
    externalId: item.externalId,
    type: 'file',
    title: path.basename(item.absPath),
    markdown: item.markdownText,
    ...(item.binary ? { binary: item.binary } : {}),
    url: `file://${encodeURI(item.absPath)}`,
    metadata: {
      size: item.size,
      mtime: item.mtimeIso,
      ext: item.ext,
      absPath: item.absPath,
    },
    createdAt: item.createdIso,
  };
}
