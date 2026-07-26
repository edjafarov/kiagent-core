/**
 * `list_outbox` — lists recent outbound drafts and their statuses, reissuing
 * a fresh confirmation link for anything still pending.
 */
import type { OutboundToolApi } from '@main/outbound/service';

export const listOutboxDescription = `List recent outbound drafts and their statuses (draft/sending/sent/failed/discarded/delivery_unknown/expired). Pending drafts include a fresh confirmation link — use this when a confirm link has expired.`;

export const listOutboxInputSchema = {
  type: 'object',
  properties: {
    limit: { type: 'number', description: 'Max rows (default 20)' },
  },
} as const;

export function makeListOutboxTool(outbound: OutboundToolApi) {
  return async function listOutbox(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as { limit?: number };
    return outbound.listOutbox({
      limit: typeof a.limit === 'number' ? a.limit : undefined,
    });
  };
}
