/**
 * The `attachments` argument the draft tools share: files by indexed
 * document, or (local transports only) by path.
 */
import type { AttachmentInput } from '@main/outbound/attachments';

export const attachmentsSchema = {
  type: 'array',
  description:
    'Files to attach: {"document_id": "<id>"} for an indexed file or email ' +
    'attachment, or {"path": "/Users/…/file.pdf"} for a file in the home ' +
    'folder (apps on this computer only). 18 MB in total.',
  items: {
    type: 'object',
    properties: {
      document_id: { type: 'string' },
      path: { type: 'string' },
    },
  },
} as const;

export function parseAttachments(
  tool: string,
  v: unknown,
): AttachmentInput[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v))
    throw new Error(`${tool}: attachments must be an array`);
  return v.map((x) => {
    const o = (x ?? {}) as { document_id?: unknown; path?: unknown };
    if (typeof o.document_id === 'string' && o.document_id)
      return { document_id: o.document_id };
    if (typeof o.path === 'string' && o.path) return { path: o.path };
    throw new Error(`${tool}: each attachment needs a document_id or a path`);
  });
}
