module.exports = {
  async activate(host) {
    // Registered during activate() — real extensions re-register on every
    // fresh incarnation (crash respawn included), which is exactly the
    // property the stale-incarnation gate depends on.
    await host.ui.handle('echo', async (payload) => ({ echoed: payload }));
    await host.ui.handle('boom', async () => {
      throw new Error('boom from ext');
    });
    // C1: an IN-PROCESS child (createInMemoryHostPair) passes this return
    // value back by REFERENCE — no serialization boundary at all — so a
    // live function on the resolved value reaches ext:invoke's dispatch
    // completely intact unless something clones it first. A FORKED child
    // sends it over a real process channel, which fails the send itself
    // (see transport.ts's reply hardening) — same intent, different layer.
    await host.ui.handle('unclonableFn', async () => ({ f() {} }));
    await host.ui.handle('unclonablePromise', async () => ({
      p: Promise.resolve(1),
    }));

    return {
      tools: [
        {
          name: 'ui.unhandleEcho',
          description: 'unregisters the echo handler',
          inputSchema: { type: 'object' },
          async call() {
            await host.ui.unhandle('echo');
            return { ok: true };
          },
        },
        {
          name: 'ui.handleDuplicate',
          description:
            'attempts to register echo again while it is still live — must reject',
          inputSchema: { type: 'object' },
          async call() {
            try {
              await host.ui.handle('echo', async () => 'dup');
              return { ok: true };
            } catch (error) {
              return { ok: false, message: error && error.message };
            }
          },
        },
        {
          name: 'ui.broadcast',
          description: 'broadcasts a name/payload pair',
          inputSchema: { type: 'object' },
          async call(args) {
            await host.ui.broadcast(args.name, args.payload);
            return { ok: true };
          },
        },
      ],
    };
  },
};
