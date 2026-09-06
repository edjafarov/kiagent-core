/** Events e2e fixture B (issue #112): subscribes to a peer's data event
 *  ('x.record') and to the platform's own lifecycle event
 *  ('extension.activated') — both delivered with host-stamped meta. Records
 *  every delivery, verbatim (payload + meta), for a tool to read back so the
 *  test can assert on meta.from without reaching into host internals. */
const records = [];
const activations = [];

module.exports = {
  async activate(host) {
    host.events.on('x.record', (payload, meta) => {
      records.push({ payload, meta });
    });
    host.events.on('extension.activated', (payload, meta) => {
      activations.push({ payload, meta });
    });
    return {
      tools: [
        {
          name: 'eventsB.getRecords',
          description: 'returns every x.record this extension observed',
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return { records };
          },
        },
        {
          name: 'eventsB.getActivations',
          description:
            'returns every extension.activated this extension observed',
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return { activations };
          },
        },
      ],
    };
  },
};
