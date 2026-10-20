/**
 * Original bytes of an indexed document, for a trusted bundled extension
 * (the assistant stages a document the owner refers to into a files
 * workspace). The same path the convert worker uses: the document's own
 * source `fetchBytes`, with a session of its account.
 */
import path from 'node:path';

import type { Account, Document, Session, Source } from '@shared/contracts';

export const DOCUMENT_BYTES_MAX = 50 * 1024 * 1024;

export const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  txt: 'text/plain',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export interface DocumentBytes {
  bytes: Uint8Array;
  filename: string;
  mime: string;
}

export interface DocumentBytesApi {
  /** null when the document is unknown or its source cannot serve bytes. */
  fetchBytes(docId: string): Promise<DocumentBytes | null>;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

export function createDocumentBytes(deps: {
  document(id: string): Promise<Document | null>;
  account(id: string): Promise<Account | null>;
  sources: { get(id: string): Source<unknown, unknown> | undefined };
  session(account: Account, signal: AbortSignal): Session;
}): DocumentBytesApi {
  return {
    async fetchBytes(docId) {
      const doc = await deps.document(docId);
      if (!doc || doc.archivedAt) return null;
      const account = await deps.account(doc.accountId);
      if (!account) return null;
      const src = deps.sources.get(account.source);
      if (!src?.fetchBytes) return null;
      const m = doc.metadata ?? {};
      // Refuse before downloading when the source recorded a size.
      const declared = Number(m.size ?? m.sizeBytes);
      if (Number.isFinite(declared) && declared > DOCUMENT_BYTES_MAX)
        throw new Error('documents: file too large (50 MB max)');
      const bytes = await src.fetchBytes(
        deps.session(account, new AbortController().signal),
        doc,
      );
      if (!bytes) return null;
      if (!(bytes instanceof Uint8Array))
        throw new Error('documents: source returned no bytes');
      if (bytes.byteLength > DOCUMENT_BYTES_MAX)
        throw new Error('documents: file too large (50 MB max)');
      const filename = path.basename(
        str(m.filename) ?? str(m.name) ?? str(doc.title) ?? 'file',
      );
      const ext = path.extname(filename).slice(1).toLowerCase();
      const mime =
        str(m.mimeType) ??
        str(m.mime) ??
        MIME_BY_EXT[ext] ??
        'application/octet-stream';
      return { bytes, filename, mime };
    },
  };
}
