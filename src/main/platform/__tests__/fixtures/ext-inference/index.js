/** Inference e2e fixture (issue #107): exercises `host.inference.complete`
 *  and `host.inference.describe` from inside a REAL forked child, so a
 *  rejection has to survive `extension-rpc.ts`/`transport.ts` — both
 *  `LaneClosedError` and `ModelChangedError` must still be discriminable by
 *  `name` (never `instanceof`) once they land back in the test process. */
module.exports = {
  async activate(host) {
    return {
      tools: [
        {
          name: 'infTest.completeBackground',
          description:
            "calls complete with lane:'background' — rejects with LaneClosedError while the lane is closed",
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return host.inference.complete('classify this', {
              lane: 'background',
            });
          },
        },
        {
          name: 'infTest.describeComplete',
          description: "returns host.inference.describe('complete')",
          inputSchema: { type: 'object', properties: {} },
          async call() {
            return host.inference.describe('complete');
          },
        },
        {
          name: 'infTest.completeWithGeneration',
          description:
            'calls complete with the given generation — rejects with ModelChangedError if the plane has moved on',
          inputSchema: {
            type: 'object',
            properties: { generation: { type: 'number' } },
            required: ['generation'],
          },
          async call(args) {
            return host.inference.complete('classify this', {
              generation: args.generation,
            });
          },
        },
      ],
    };
  },
};
