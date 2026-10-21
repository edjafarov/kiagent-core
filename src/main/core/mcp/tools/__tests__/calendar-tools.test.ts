import type {
  CalendarToolApi,
  DraftEventArgs,
} from '@main/calendar-out/service';
import type { Query } from '@shared/contracts';

import { summarizeCall } from '../../activity';
import { redactArgsForLog } from '../../registry';
import { buildBuiltinTools } from '../index';

describe('calendar MCP tools', () => {
  const seen: DraftEventArgs[] = [];
  const api: CalendarToolApi = {
    listCalendars: async () => [],
    findFreeTime: async () => ({
      timeZone: 'Europe/Berlin',
      coverage: { calendars: [], notIndexedWritable: [], warnings: [] },
      complete: true,
      slots: [],
      busy: [],
    }),
    draftEvent: async (a) => {
      seen.push(a);
      return {
        draftId: 'd1',
        revision: 1,
        mode: 'review',
        calendar: { id: 'c', name: 'Family', accountEmail: 'me@x' },
        similarEvents: [],
        instruction: 'ok',
      };
    },
  };
  const tools = buildBuiltinTools({} as Query, undefined, api);
  const tool = (n: string) => tools.find((t) => t.name === n)!;

  it('calendar tools are registered with their schemas', () => {
    expect(tool('list_calendars')).toBeDefined();
    expect(tool('find_free_time').inputSchema).toMatchObject({
      required: ['from', 'to', 'duration_minutes'],
    });
    expect(tool('draft_event').inputSchema).toMatchObject({
      required: ['title', 'start', 'category'],
      properties: {
        category: { enum: ['work', 'personal', 'kids'] },
        conference: { enum: ['none', 'auto'] },
      },
    });
    // no confirm tool exists
    expect(tools.map((t) => t.name).filter((n) => /event/.test(n))).toEqual([
      'draft_event',
    ]);
  });

  it('draft_event maps snake_case args to DraftEventArgs', async () => {
    const out = await tool('draft_event').call({
      title: 'Call with Anna (Acme)',
      start: '2026-11-03T10:00',
      time_zone: 'Europe/Berlin',
      calendar_id: 'c',
      category: 'work',
      attendees: [{ email: 'anna@acme.com', name: 'Anna' }],
      conference: 'auto',
      source_document_id: 'doc-1',
    });
    expect(seen[0]).toMatchObject({
      title: 'Call with Anna (Acme)',
      start: '2026-11-03T10:00',
      timeZone: 'Europe/Berlin',
      calendarId: 'c',
      category: 'work',
      attendees: [{ email: 'anna@acme.com', name: 'Anna' }],
      conference: 'auto',
      sourceDocumentId: 'doc-1',
      force: false,
    });
    expect(out).toMatchObject({
      draft_id: 'd1',
      revision: 1,
      calendar: { calendar_id: 'c' },
    });
    await expect(
      tool('draft_event').call({
        title: 'x',
        start: '2026-11-03',
        category: 'fun',
      }),
    ).rejects.toThrow(/category/);
  });

  it('without a calendar service the tools explain themselves', async () => {
    const cold = buildBuiltinTools({} as Query);
    await expect(
      cold.find((t) => t.name === 'list_calendars')!.call({}),
    ).rejects.toThrow(/unavailable/);
  });

  it('activity log redacts draft_event description and attendees', () => {
    const logged = redactArgsForLog({
      title: 'Dentist',
      description: 'private note from the mail',
      attendees: [{ email: 'a@x' }, { email: 'b@x' }],
    });
    expect(logged.description).toBe('[redacted: 26 chars]');
    expect(logged.attendees).toBe('[2 recipients]');
    const s = summarizeCall(
      'draft_event',
      { title: 'Secret', description: 'x' },
      { draft_id: 'd1' },
    );
    expect(JSON.stringify(s)).not.toMatch(/Secret/);
    expect(s.summary).toMatch(/d1/);
  });
});
