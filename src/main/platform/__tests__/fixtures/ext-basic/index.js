/** Minimal end-to-end fixture: one 'none'-auth source yielding two docs. */
module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'basicsrc',
            name: 'Basic Source',
            documentTypes: ['basic.item'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'basic-account', config: {} };
          },
          async *pull(session, cursor) {
            const start = (cursor && cursor.n) || 0;
            for (let n = start; n < 2; n += 1) {
              if (session.signal.aborted) return;
              yield {
                phase: n === 0 ? 'backfill' : 'live',
                items: [{ n }],
                cursor: { n: n + 1 },
                estimateTotal: 2,
              };
            }
          },
          toDocument(item) {
            return {
              externalId: `basic-${item.n}`,
              type: 'basic.item',
              title: `Basic doc ${item.n}`,
              markdown: `body ${item.n}`,
              metadata: {},
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
          async *reconcile(session) {
            if (session.signal.aborted) return;
            // Lists ONLY basic-0 as live upstream. During the first engine
            // cycle both docs commit AFTER reconcile's startSeq snapshot, so
            // the TOCTOU guard archives nothing; a SECOND cycle sees basic-1
            // stored below startSeq and absent upstream -> archived.
            yield [{ externalId: 'basic-0', type: 'basic.item' }];
          },
        },
      ],
      tools: [
        {
          name: 'basic_echo',
          description: 'echoes',
          inputSchema: { type: 'object' },
          call: async (args) => ({ echoed: args }),
        },
      ],
    };
  },
};
