/** A bundled (tier 'bundled', origin 'bundled') fixture that does NOT
 *  declare unsafe.mainProcess — used to prove the in-process transport
 *  branch is cap-gated, not origin-gated: even a bundled extension without
 *  the privileged cap must go through the platform's injected
 *  transportFactory like any forked/out-of-process host. */
module.exports = {
  async activate() {
    return {
      sources: [],
      tools: [
        {
          name: 'bundled-nonpriv.probe',
          description: 'no-op probe for a non-privileged bundled extension',
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return {};
          },
        },
      ],
    };
  },
};
