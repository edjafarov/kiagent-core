/**
 * `schedule_drafts` — times for several pending drafts at once (alpha-cent
 * docs/superpowers/specs/2026-10-21-outbox-formatted-mail-send-menu-design.md
 * §5.1). In chat confirmation mode it schedules (the user agreed in chat);
 * otherwise each time is a suggestion the user confirms in KIAgent or on the
 * draft's link. Kia can pick the times: `spread` over a window.
 */
import type { OutboundToolApi, ScheduleItem } from '@main/outbound/service';

export const scheduleDraftsDescription = `Schedule when pending drafts are sent — one or many, e.g. several emails to different people spread over 2 hours. Give each draft its draft_id and the revision the user saw, and EITHER a send_at for every draft (ISO 8601 with a UTC offset; null cancels) OR spread {minutes, start?} and Kia picks distinct random times inside that window. In chat confirmation mode this schedules them: call it ONLY after the user agreed in this conversation to the recipients, the texts and the times (or the spread). In the other modes nothing is scheduled: each time is a suggestion the user confirms per draft in KIAgent or on the returned confirm_url — show those links. Results are per draft; a draft that changed returns its new revision.`;

export const scheduleDraftsInputSchema = {
  type: 'object',
  properties: {
    drafts: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          draft_id: { type: 'string' },
          revision: {
            type: 'integer',
            description: 'The revision of the draft the user saw',
          },
          send_at: {
            type: ['string', 'null'],
            description:
              'When to send (ISO 8601 with offset), or null to cancel. Omit when using spread.',
          },
        },
        required: ['draft_id', 'revision'],
      },
    },
    spread: {
      type: 'object',
      description: 'Let Kia pick the times inside a window',
      properties: {
        minutes: {
          type: 'integer',
          minimum: 5,
          maximum: 1440,
          description: 'Window length; at least one minute per draft',
        },
        start: {
          type: 'string',
          description:
            'Window start (ISO 8601 with offset). Default: 5 min from now in chat mode, else 30 min.',
        },
      },
      required: ['minutes'],
    },
  },
  required: ['drafts'],
} as const;

export function makeScheduleDraftsTool(outbound: OutboundToolApi) {
  return async function scheduleDrafts(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as { drafts?: unknown; spread?: unknown };
    if (!Array.isArray(a.drafts))
      throw new Error('schedule_drafts: drafts must be an array');
    const drafts: ScheduleItem[] = a.drafts.map((d, i) => {
      const x = (d ?? {}) as Record<string, unknown>;
      if (typeof x.draft_id !== 'string' || !x.draft_id)
        throw new Error(`schedule_drafts: drafts[${i}].draft_id is required`);
      const revision = Number(x.revision);
      if (!Number.isInteger(revision) || revision < 1)
        throw new Error(`schedule_drafts: drafts[${i}].revision is required`);
      if (
        x.send_at !== undefined &&
        x.send_at !== null &&
        typeof x.send_at !== 'string'
      )
        throw new Error(
          `schedule_drafts: drafts[${i}].send_at must be a string or null`,
        );
      return {
        draftId: x.draft_id,
        revision,
        ...(x.send_at !== undefined && {
          sendAt: x.send_at as string | null,
        }),
      };
    });
    let spread: { start?: string; minutes: number } | undefined;
    if (a.spread !== undefined) {
      const s = (a.spread ?? {}) as Record<string, unknown>;
      if (s.start !== undefined && typeof s.start !== 'string')
        throw new Error('schedule_drafts: spread.start must be a string');
      spread = {
        minutes: Number(s.minutes),
        ...(typeof s.start === 'string' && { start: s.start }),
      };
    }
    return outbound.scheduleDrafts({ drafts, ...(spread && { spread }) });
  };
}
