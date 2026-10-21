/**
 * `revise_draft` — changes a pending outbox draft in place (alpha-cent
 * docs/superpowers/specs/2026-10-20-outbox-draft-sync-design.md §4.2). The
 * caller names the revision it last saw; a mismatch refuses with the current
 * draft. Nothing is sent here.
 */
import type { OutboundToolApi } from '@main/outbound/service';

import { attachmentsSchema, parseAttachments } from './attachment-args';

export const reviseDraftDescription = `Change a pending DRAFT in place (a draft_id from draft_reply, draft_message or list_outbox): pass its draft_id and the revision you last saw, plus only the fields to change. NOTHING IS SENT. Use this for every change the user asks for — never create another draft. If the draft changed meanwhile (the user edited it), this refuses and returns the current draft: show it and revise from that. A reply keeps the recipients of the original message. The body is Markdown, sent as a formatted email.`;

export const reviseDraftInputSchema = {
  type: 'object',
  properties: {
    draft_id: { type: 'string' },
    revision: {
      type: 'integer',
      description: 'The revision of the draft you last saw',
    },
    body: { type: 'string', description: 'The whole new body' },
    subject: { type: 'string' },
    to: {
      type: 'array',
      items: { type: 'string' },
      description: 'New recipients (new messages only)',
    },
    cc: {
      type: 'array',
      items: { type: 'string' },
      description: 'New Cc (new messages only)',
    },
    add_attachments: attachmentsSchema,
    remove_attachments: {
      type: 'array',
      items: { type: 'string' },
      description: 'Filenames of attached files to take off',
    },
  },
  required: ['draft_id', 'revision'],
} as const;

export function makeReviseDraftTool(outbound: OutboundToolApi) {
  return async function reviseDraft(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as {
      draft_id?: string;
      revision?: unknown;
      body?: string;
      subject?: string;
      to?: unknown;
      cc?: unknown;
      add_attachments?: unknown;
      remove_attachments?: unknown;
    };
    if (!a.draft_id) throw new Error('revise_draft: draft_id is required');
    const revision = Number(a.revision);
    if (!Number.isInteger(revision) || revision < 1)
      throw new Error('revise_draft: revision is required');
    const list = (v: unknown, name: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v))
        throw new Error(`revise_draft: ${name} must be an array`);
      return v.map(String);
    };
    return outbound.reviseDraft({
      draftId: a.draft_id,
      revision,
      ...(typeof a.body === 'string' ? { body: a.body } : {}),
      ...(typeof a.subject === 'string' ? { subject: a.subject } : {}),
      ...(a.to !== undefined ? { to: list(a.to, 'to') } : {}),
      ...(a.cc !== undefined ? { cc: list(a.cc, 'cc') } : {}),
      ...(a.add_attachments !== undefined
        ? {
            addAttachments: parseAttachments('revise_draft', a.add_attachments),
          }
        : {}),
      ...(a.remove_attachments !== undefined
        ? {
            removeAttachments: list(a.remove_attachments, 'remove_attachments'),
          }
        : {}),
    });
  };
}
