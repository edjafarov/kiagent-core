/** Role fixture: host.role.get() needs no cap, and the platform's
 *  'sync.role' event is recorded for a tool to read back: its payload, its
 *  meta, and what the getter answered while the handler ran. */
const seen = [];

module.exports = {
  async activate(host) {
    host.events.on('sync.role', async (payload, meta) => {
      const role = await host.role.get();
      seen.push({ payload, meta, role });
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
