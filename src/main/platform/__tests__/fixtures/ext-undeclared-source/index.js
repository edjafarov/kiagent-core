/** F6 fixture: activate() contributes a source id NOT listed in the
 *  manifest's `contributes.sources` (only 'declaredsrc' is declared) — the
 *  platform must skip the undeclared one (warn) and still register the
 *  declared one. */
module.exports = {
  async activate() {
    const makeSource = (id) => ({
      descriptor: {
        id,
        name: id,
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
          externalId: `${id}-${item.n}`,
          type: 'basic.item',
          title: `${id} doc ${item.n}`,
          markdown: `body ${item.n}`,
          metadata: {},
          createdAt: '2026-01-01T00:00:00.000Z',
        };
      },
    });
    return {
      sources: [makeSource('declaredsrc'), makeSource('sneakysrc')],
      tools: [],
    };
  },
};
