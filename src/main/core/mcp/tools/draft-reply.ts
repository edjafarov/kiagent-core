/**
 * `draft_reply` — creates a frozen outbox draft replying to a corpus
 * document. Recipients/threading are resolved by the app from stored
 * metadata; the model supplies no address. Nothing is sent here: the result
 * carries the user-confirmation instructions (spec §4).
 */
import type { OutboundToolApi } from '@main/outbound/service';

export const draftReplyDescription = `Create a DRAFT reply to an email document from the corpus (use the document id from search/get results). The app resolves the recipient and threading from the stored document — do not supply addresses. NOTHING IS SENT by this tool: the result includes an instruction and a confirmation link for the user; follow the instruction exactly.`;

export const draftReplyInputSchema = {
  type: 'object',
  properties: {
    document_id: {
      type: 'string',
      description: 'Corpus document id of the message being replied to',
    },
    body: { type: 'string', description: 'Reply body (plain text/markdown)' },
    reply_all: {
      type: 'boolean',
      description:
        'Also address the other stored recipients of the original (default false)',
    },
  },
  required: ['document_id', 'body'],
} as const;

export function makeDraftReplyTool(outbound: OutboundToolApi) {
  return async function draftReply(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as {
      document_id?: string;
      body?: string;
      reply_all?: boolean;
    };
    if (!a.document_id) throw new Error('draft_reply: document_id is required');
    if (!a.body) throw new Error('draft_reply: body is required');
    return outbound.draftReply({
      documentId: a.document_id,
      body: a.body,
      replyAll: a.reply_all === true,
    });
  };
}
