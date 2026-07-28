/**
 * Fixture for extension-contributed outbound senders: the manifest declares
 * `caps: ['send']` and `contributes.senders: ['fixsrc']`, so activating this
 * extension must register a host-side sender proxy under 'fixsrc'.
 *
 * `sender_last_ctx` reports the SenderContext the host actually delivered on
 * the last send. Sender.send's `ctx` parameter is OPTIONAL in the contract,
 * so a host that forgot to pass it would still compile and still return a
 * green SendResult — this tool is how the test proves the credentials really
 * crossed the RPC.
 */
let lastCtx;

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
      tools: [
        {
          name: 'sender_last_ctx',
          description: 'reports the SenderContext seen by the last send',
          inputSchema: { type: 'object' },
          call: async () => ({ ctx: lastCtx === undefined ? null : lastCtx }),
        },
      ],
      senders: {
        fixsrc: {
          send: async (intent, ctx) => {
            lastCtx = ctx === undefined ? null : ctx;
            void intent;
            return { externalMessageId: 'fix-1' };
          },
        },
      },
    };
  },
};
