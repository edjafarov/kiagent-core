/**
 * `send_draft` — sends a pending draft after the user explicitly agreed in
 * chat (spec §5 mode C). Only honored when BOTH the draft's frozen mode and
 * the effective current mode are 'chat'; other drafts confirm on an
 * app-served page (the draft result carries the link). Chat mode is a GLOBAL
 * Settings opt-in (decision 2026-07-27); the app-side gates are that opt-in
 * and an hourly rate limit — the user's consent itself is observed by the
 * model, which is why chat mode is opt-in and never the default.
 */
import type { OutboundToolApi } from '@main/outbound/service';

export const sendDraftDescription = `Send a pending outbound draft after the user has explicitly agreed in this conversation. Only works when chat confirmation mode is enabled in the app settings; otherwise present the confirm link from the draft result instead. The draft must have been shown to the user verbatim first.`;

export const sendDraftInputSchema = {
  type: 'object',
  properties: {
    draft_id: {
      type: 'string',
      description: 'The draft_id returned by draft_reply or draft_message',
    },
  },
  required: ['draft_id'],
} as const;

export function makeSendDraftTool(outbound: OutboundToolApi) {
  return async function sendDraft(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as { draft_id?: string };
    if (!a.draft_id) throw new Error('send_draft: draft_id is required');
    return outbound.sendDraft({ draftId: a.draft_id });
  };
}
