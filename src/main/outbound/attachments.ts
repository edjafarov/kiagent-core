/**
 * Files on an Outbox draft (alpha-cent
 * docs/superpowers/specs/2026-10-20-outbox-draft-sync-design.md §6). No
 * copies are kept: a file is named by where it came from — an indexed
 * document or a local path — and its bytes are read from there when they are
 * written to the provider draft or sent.
 */
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
 *  folder, no `.`/`..` segments, outside ~/Library. Checked on the path as
 *  given and again once symlinks are resolved. */
function pathRefusal(p: string, home: string): string | null {
  if (!path.isAbsolute(p)) return 'the path must be absolute';
  if (p.split(/[\\/]+/).some((s) => s === '.' || s === '..'))
    return 'the path must not contain . or .. segments';
  const rel = path.relative(home, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    return 'only files inside your home folder can be attached';
  const top = rel.split(path.sep)[0];
  if (top === 'Library') return 'files under ~/Library cannot be attached';
  return null;
}

export function createAttachments(deps: {
  documentBytes: DocumentBytesApi;
  home?: string;
}): AttachmentsApi {
  const home = deps.home ?? os.homedir();
  let homeReal = home;
  try {
    homeReal = realpathSync(home);
  } catch {
    // keep the given one
  }
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
            from: { kind: 'document', documentId: input.document_id },
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
        const why = pathRefusal(p, home);
        if (why) throw new Error(`cannot attach ${p}: ${why}`);
      }
      let real: string;
      let stat: Awaited<ReturnType<typeof fsp.stat>>;
      try {
        real = await fsp.realpath(p);
        stat = await fsp.stat(real);
      } catch {
        throw new Error(`cannot attach ${p}: no such file`);
      }
      if (!opts.userPicked) {
        const why = pathRefusal(real, homeReal);
        if (why) throw new Error(`cannot attach ${p}: ${why}`);
      }
      if (!stat.isFile()) throw new Error(`cannot attach ${p}: not a file`);
      if (stat.size > ATTACHMENTS_MAX_BYTES)
        throw new Error(
          `cannot attach ${p}: it is ${mb(stat.size)} — the limit is ${mb(ATTACHMENTS_MAX_BYTES)}`,
        );
      const filename = path.basename(p);
      const mime = mimeOf(filename);
      const bytes = await readFile(real, filename);
      return {
        attachment: {
          filename,
          mime,
          size: bytes.byteLength,
          from: { kind: 'file', path: p },
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
      if (a.from.kind === 'file') {
        const bytes = await readFile(a.from.path, a.filename);
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
      return {
        filename: a.filename,
        mime: a.mime,
        contentBase64: Buffer.from(got.bytes).toString('base64'),
      };
    },
  };
}
