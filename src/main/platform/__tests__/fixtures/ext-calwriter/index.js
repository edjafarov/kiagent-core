/**
 * Fixture for extension calendar writers (platform 2.16.0): declares
 * `caps: ['calendar.write']` and `contributes.calendarWriters`. activate()
 * returns three writers: 'calsrc' (declared, source registered — the one
 * that must survive), 'sneakysrc' (never declared) and 'ghostsrc' (declared,
 * but no source behind it). `writer_calls` reports what reached the child,
 * ctx included — the ctx is how credentials cross the RPC.
 */
const calls = [];

const writer = (tag) => ({
  async listCalendars(ctx) {
    calls.push({ tag, op: 'listCalendars', ctx });
    return [
      {
        id: 'primary@cal',
        name: 'Me',
        color: null,
        primary: true,
        canWrite: true,
        shared: false,
        timeZone: 'Europe/Berlin',
      },
    ];
  },
  async createEvent(intent, ctx) {
    calls.push({ tag, op: 'createEvent', intent, ctx });
    return {
      eventId: `ev-${intent.idempotencyKey}`,
      iCalUID: null,
      htmlLink: null,
      conferenceUrl: null,
      conferencePending: false,
      note: null,
    };
  },
});

module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'calsrc',
            name: 'Calendar Fixture Source',
            documentTypes: ['calendar.event'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'cal-account', config: {} };
          },
          async *pull() {},
          toDocument() {
            throw new Error('unused');
          },
        },
      ],
      tools: [
        {
          name: 'writer_calls',
          description: 'reports every calendar writer op that reached the child',
          inputSchema: { type: 'object' },
          call: async () => ({ calls }),
        },
      ],
      calendarWriters: {
        calsrc: writer('calsrc'),
        sneakysrc: writer('sneakysrc'),
        ghostsrc: writer('ghostsrc'),
      },
    };
  },
};
