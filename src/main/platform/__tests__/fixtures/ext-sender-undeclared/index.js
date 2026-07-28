/**
 * Fixture for the two id-scoping gates on sender registration. It holds the
 * 'send' cap, so prong (a) passes for everything here — what's under test is
 * that the id itself must check out:
 *
 *  - 'okaysrc'   declared in contributes.senders AND registered as a source
 *                → registers.
 *  - 'ghostsrc'  declared in contributes.senders but backed by NO source
 *                → skipped (prong c).
 *  - 'sneakysrc' returned by activate() but absent from contributes.senders
 *                → skipped (prong b). The child fills `Contributions.senders`
 *                purely from its own return value and never sees the
 *                manifest, so an extension can claim any id it likes here;
 *                the host-side gate is the only thing standing between that
 *                claim and a live outbound transport.
 */
const sender = (id) => ({
  send: async () => ({ externalMessageId: `${id}-1` }),
});

module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'okaysrc',
            name: 'Okay Source',
            documentTypes: ['fix.item'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'okay-account', config: {} };
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
              externalId: `okay-${item.n}`,
              type: 'fix.item',
              title: `Okay doc ${item.n}`,
              markdown: `body ${item.n}`,
              metadata: {},
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
        },
      ],
      tools: [],
      senders: {
        okaysrc: sender('okaysrc'),
        ghostsrc: sender('ghostsrc'),
        sneakysrc: sender('sneakysrc'),
      },
    };
  },
};
