/**
 * `draft_message` — creates a frozen outbox draft to explicit recipients
 * from a chosen sending account. Nothing is sent here: the result carries
 * the user-confirmation instructions (spec §4).
 */
import type { OutboundToolApi } from '@main/outbound/service';

export const draftMessageDescription = `Create a DRAFT email to explicit recipients from one of the user's email accounts (account ids come from digital_memory_info). NOTHING IS SENT by this tool: the result includes an instruction and a confirmation link for the user; follow the instruction exactly.`;

export const draftMessageInputSchema = {
  type: 'object',
  properties: {
    account_id: { type: 'string', description: 'Sending account id' },
    to: {
      type: 'array',
      items: { type: 'string' },
      description: 'Recipient email addresses',
    },
    subject: { type: 'string' },
    body: { type: 'string', description: 'Body (plain text/markdown)' },
  },
  required: ['account_id', 'to', 'subject', 'body'],
} as const;

export function makeDraftMessageTool(outbound: OutboundToolApi) {
  return async function draftMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as {
      account_id?: string;
      to?: unknown;
      subject?: string;
      body?: string;
    };
    if (!a.account_id) throw new Error('draft_message: account_id is required');
    if (!Array.isArray(a.to) || a.to.length === 0)
      throw new Error('draft_message: to must be a non-empty array');
    if (!a.subject) throw new Error('draft_message: subject is required');
    if (!a.body) throw new Error('draft_message: body is required');
    return outbound.draftMessage({
      accountId: a.account_id,
      to: a.to.map(String),
      subject: a.subject,
      body: a.body,
    });
  };
}
