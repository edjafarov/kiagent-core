/**
 * Same contributions as ext-sender — including `contributes.senders` and a
 * live sender returned from activate() — but the manifest declares NO caps.
 * Registration must warn and register no sender; the source still registers.
 * `contributes.senders` alone is not a grant.
 */
module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'fixsrc',
            name: 'Sender Fixture Source',
            documentTypes: ['fix.item'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'fix-account', config: {} };
          },
          async *pull(session) {
            if (session.signal.aborted) return;
            yield {
              phase: 'live',
              items: [{ n: 0 }],
              cursor: { n: 1 },
              estimateTotal: 1,
            };
          },
          toDocument(item) {
            return {
              externalId: `fix-${item.n}`,
              type: 'fix.item',
              title: `Fix doc ${item.n}`,
              markdown: `body ${item.n}`,
              metadata: {},
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
        },
      ],
      tools: [],
      senders: {
        fixsrc: {
          send: async () => ({ externalMessageId: 'nocap-1' }),
        },
      },
    };
  },
};
