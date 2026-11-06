/** Role fixture: host.role.get() needs no cap, and the platform's
 *  'sync.role' event is recorded verbatim for a tool to read back. */
const seen = [];

module.exports = {
  async activate(host) {
    host.events.on('sync.role', (payload) => {
      seen.push(payload);
    });
    return {
      tools: [
        {
          name: 'role_probe',
          description: 'the current role and every sync.role event seen',
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return { role: await host.role.get(), seen };
          },
        },
      ],
    };
  },
};
