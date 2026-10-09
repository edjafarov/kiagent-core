/** In-process fixture whose FIRST activation is slow by a test-controlled
 *  amount. The control object arrives as `extras.mainProcess.slowFirstActivate`
 *  (the platform's `mainApi` dep), shared by reference with the test: the
 *  module is loaded through native Module._load (not Jest's VM, so Jest's
 *  globalThis is not visible here) and the in-process tier busts its require
 *  cache on every exit, so module state cannot carry "already slowed once". */
module.exports = {
  async activate(_host, extras) {
    const slow =
      extras && extras.mainProcess
        ? extras.mainProcess.slowFirstActivate
        : null;
    if (slow && slow.ms) {
      const { ms } = slow;
      slow.ms = 0;
      await new Promise((r) => setTimeout(r, ms));
    }
    return {
      sources: [],
      tools: [
        {
          name: 'slow.probe',
          description: 'probe',
          inputSchema: { type: 'object' },
          async call() {
            return { ok: true };
          },
        },
      ],
    };
  },
};
