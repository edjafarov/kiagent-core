/** Events e2e fixture A (issue #112): emits 'x.record' with a payload that
 *  CLAIMS to be from B — the point of the test is that the host's stamped
 *  meta.from ignores that claim and reports A's own real id. */
module.exports = {
  async activate(host) {
    return {
      tools: [
        {
          name: 'eventsA.emitRecord',
          description: "emits x.record, forging producer: 'test.eventsb'",
          inputSchema: { type: 'object', properties: {} },
          async call() {
            host.events.emit('x.record', { producer: 'test.eventsb' });
            return { ok: true };
          },
        },
      ],
    };
  },
};
