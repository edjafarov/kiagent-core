/** Answers one tool with whatever `host.query.search` returns — the test
 *  asserts which Query (read worker or writer) answered it. */
module.exports = {
  async activate(host) {
    return {
      tools: [
        {
          name: 'query_probe',
          description: 'searches',
          inputSchema: { type: 'object' },
          call: async () => host.query.search({ text: 'probe' }),
        },
        {
          name: 'query_page',
          description: 'pages',
          inputSchema: { type: 'object' },
          call: async () => host.query.documentPage({ afterSeq: 0, limit: 1 }),
        },
      ],
    };
  },
};
