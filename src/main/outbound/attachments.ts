/**
 * Files on an Outbox draft (alpha-cent
 * docs/superpowers/specs/2026-10-20-outbox-draft-sync-design.md §6). No
 * copies are kept: a file is named by where it came from — an indexed
 * document or a local path — and its bytes are read from there when they are
 * written to the provider draft or sent.
 */
import { createHash } from 'node:crypto';
import { promises as fsp, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OutboxAttachment } from '@shared/contracts';

import type { McpTransport } from '../core/mcp/transport-context';
import { MIME_BY_EXT, type DocumentBytesApi } from './document-bytes';

/** Gmail's 25 MB is on the encoded message; base64 grows files by a third. */
export const ATTACHMENTS_MAX_BYTES = 18 * 1024 * 1024;

export type AttachmentInput = { document_id: string } | { path: string };

export interface AttachmentBytes {
  filename: string;
  mime: string;
  contentBase64: string;
}

export interface AttachmentsApi {
  /** The attachment and its bytes. `userPicked`: a file the user chose in
   *  the app, which the path rule (there to stop a model reading arbitrary
   *  files) does not apply to. */
  resolve(
    input: AttachmentInput,
    opts: { transport: McpTransport; userPicked?: boolean },
  ): Promise<{ attachment: OutboxAttachment; bytes: AttachmentBytes }>;
  /** Bytes from the origin, for a send or a provider write. */
  read(a: OutboxAttachment): Promise<AttachmentBytes>;
}

/** What the bytes were when the file was added: a file swapped for other
 *  bytes is an edit, and a send never carries bytes nobody reviewed. */
const shaOf = (b: Uint8Array) =>
  createHash('sha256').update(b).digest('hex').slice(0, 32);

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

const mimeOf = (filename: string) =>
  MIME_BY_EXT[path.extname(filename).slice(1).toLowerCase()] ??
  'application/octet-stream';

/** Duplicate names and the total size, over the draft's whole list. */
export function checkAttachments(list: OutboxAttachment[]): void {
  const seen = new Set<string>();
  for (const a of list) {
    if (seen.has(a.filename))
      throw new Error(`a file named "${a.filename}" is already on this draft`);
    seen.add(a.filename);
  }
  const total = list.reduce((n, a) => n + a.size, 0);
  if (total > ATTACHMENTS_MAX_BYTES)
    throw new Error(
      `attachments are ${mb(total)} — the limit is ${mb(ATTACHMENTS_MAX_BYTES)}`,
    );
}

/** Where a model may read a file from: an absolute path inside the home
 *  folder, no segment starting with `.` (`..`, and the dotfiles and
 *  dot-folders where keys and tokens live: ~/.ssh, ~/.aws, ~/.config…),
 *  outside ~/Library and ~/AppData (app data, this app's own profile among
 *  it) and outside the app's own data folder. Checked on the path as given
 *  and again once symlinks are resolved — at add time and at every read. */
function pathRefusal(
  p: string,
  home: string,
  blocked: string[],
): string | null {
  if (!path.isAbsolute(p)) return 'the path must be absolute';
  const rel = path.relative(home, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    return 'only files inside your home folder can be attached';
  if (p.split(/[\\/]+/).some((s) => s === '.' || s === '..'))
    return 'the path must not contain . or .. segments';
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s.startsWith('.')))
    return 'hidden files and folders (names starting with .) cannot be attached';
  if (/^(Library|AppData)$/i.test(segments[0]))
    return `files under ~/${segments[0]} cannot be attached`;
  if (blocked.some((b) => p === b || p.startsWith(b + path.sep)))
    return "the app's own data cannot be attached";
  return null;
}

export function createAttachments(deps: {
  documentBytes: DocumentBytesApi;
  home?: string;
  /** Folders never attached by path (the app's own data folder). */
  blocked?: string[];
}): AttachmentsApi {
  const home = deps.home ?? os.homedir();
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const homeReal = real(home);
  const blocked = (deps.blocked ?? []).flatMap((b) => [b, real(b)]);
  const shown = (p: string) =>
    p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;

  const readFile = async (p: string, filename: string) => {
    try {
      return await fsp.readFile(p);
    } catch {
      throw new Error(
        `attachment "${filename}" is no longer available (${shown(p)})`,
      );
    }
  };

  return {
    async resolve(input, opts) {
      if ('document_id' in input) {
        const got = await deps.documentBytes.fetchBytes(input.document_id);
        if (!got)
          throw new Error(
            `document '${input.document_id}' has no file to attach`,
          );
        const size = got.bytes.byteLength;
        return {
          attachment: {
            filename: got.filename,
            mime: got.mime,
            size,
            from: {
              kind: 'document',
              documentId: input.document_id,
              sha: shaOf(got.bytes),
            },
          },
          bytes: {
            filename: got.filename,
            mime: got.mime,
            contentBase64: Buffer.from(got.bytes).toString('base64'),
          },
        };
      }
      const p = String(input.path);
      if (!opts.userPicked) {
        if (opts.transport === 'remote')
          throw new Error(
            'files from this computer can only be attached by an app on it — attach an indexed document (document_id) instead',
          );
        const why = pathRefusal(p, home, blocked);
        if (why) throw new Error(`cannot attach ${p}: ${why}`);
      }
      let resolved: string;
      let stat: Awaited<ReturnType<typeof fsp.stat>>;
      try {
        resolved = await fsp.realpath(p);
        stat = await fsp.stat(resolved);
      } catch {
        throw new Error(`cannot attach ${p}: no such file`);
      }
      if (!opts.userPicked) {
        const why = pathRefusal(resolved, homeReal, blocked);
        if (why) throw new Error(`cannot attach ${p}: ${why}`);
      }
      if (!stat.isFile()) throw new Error(`cannot attach ${p}: not a file`);
      if (stat.size > ATTACHMENTS_MAX_BYTES)
        throw new Error(
          `cannot attach ${p}: it is ${mb(stat.size)} — the limit is ${mb(ATTACHMENTS_MAX_BYTES)}`,
        );
      const filename = path.basename(p);
      const mime = mimeOf(filename);
      const bytes = await readFile(resolved, filename);
      return {
        attachment: {
          filename,
          mime,
          size: bytes.byteLength,
          from: {
            kind: 'file',
            path: p,
            ...(opts.userPicked ? { picked: true } : {}),
            sha: shaOf(bytes),
          },
        },
        bytes: { filename, mime, contentBase64: bytes.toString('base64') },
      };
    },

    async read(a) {
      const gone = () =>
        new Error(
          `attachment "${a.filename}" is no longer available (${
            a.from?.kind === 'file'
              ? shown(a.from.path)
              : a.from
                ? 'its document is gone'
                : 'it was added in the mail app'
          })`,
        );
      if (!a.from) throw gone();
      const changed = () =>
        new Error(
          `attachment "${a.filename}" changed since it was added (${
            a.from?.kind === 'file' ? shown(a.from.path) : 'its document'
          }) — add it again`,
        );
      const same = (b: Uint8Array) =>
        b.byteLength === a.size && (!a.from?.sha || shaOf(b) === a.from.sha);
      if (a.from.kind === 'file') {
        // The rule again, on what the path points at NOW: a file or link
        // can be swapped after it was added.
        const p = a.from.path;
        let resolved: string;
        let size: number;
        try {
          resolved = await fsp.realpath(p);
          const st = await fsp.stat(resolved);
          if (!st.isFile()) throw gone();
          size = st.size;
        } catch {
          throw gone();
        }
        const why = a.from.picked
          ? null
          : (pathRefusal(p, home, blocked) ??
            pathRefusal(resolved, homeReal, blocked));
        if (why)
          throw new Error(
            `attachment "${a.filename}" can no longer be attached (${shown(p)}): ${why}`,
          );
        // Before reading: a file that grew is never loaded whole.
        if (size !== a.size) throw changed();
        const bytes = await readFile(resolved, a.filename);
        if (!same(bytes)) throw changed();
        return {
          filename: a.filename,
          mime: a.mime,
          contentBase64: bytes.toString('base64'),
        };
      }
      const got = await deps.documentBytes
        .fetchBytes(a.from.documentId)
        .catch(() => null);
      if (!got) throw gone();
      if (!same(got.bytes)) throw changed();
      return {
        filename: a.filename,
        mime: a.mime,
        contentBase64: Buffer.from(got.bytes).toString('base64'),
      };
    },
  };
}
