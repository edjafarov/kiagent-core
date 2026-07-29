/**
 * Fixture for extension-contributed outbound senders: the manifest declares
 * `caps: ['send']` and `contributes.senders: ['fixsrc']`, so activating this
 * extension must register a host-side sender proxy under 'fixsrc'.
 *
 * `sender_last_ctx` reports the SenderContext the host actually delivered on
 * the last send. Sender.send's `ctx` parameter is OPTIONAL in the contract,
 * so a host that forgot to pass it would still compile and still return a
 * green SendResult — this tool is how the test proves the credentials really
 * crossed the RPC. `sender_last_intent` does the same job for the SendIntent,
 * whose `outboundRef` is the payload the universality hook exists to carry.
 *
 * Its toDocument writes the PRODUCER side of that hook (spec §6):
 * metadata.outbound with a default `ref`/`display` plus per-message
 * `targets`. The ref is opaque to the host and must arrive back at the
 * sender below byte for byte — that whole loop is what the outbound e2e
 * pins.
 */
let lastCtx;
let lastIntent;
// `lastIntent` alone is STALE state: it survives past its send, so a caller
// that asserts on it cannot tell "the sender saw this ref" from "the sender
// was never invoked since the last time it saw this ref". The counter is
// what makes the difference observable.
const stats = { sends: 0 };

module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'fixsrc',
            name: 'Sender Fixture Source',
            documentTypes: ['fix.item'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'fix-account', config: {} };
          },
          async *pull(session) {
            if (session.signal.aborted) return;
            yield {
              phase: 'live',
              items: [{ n: 0 }],
              cursor: { n: 1 },
              estimateTotal: 1,
            };
          },
          toDocument(item) {
            return {
              externalId: `fix-${item.n}`,
              type: 'fix.item',
              title: `Fix doc ${item.n}`,
              markdown: `body ${item.n}`,
              metadata: {
                outbound: {
                  ref: { room: 'fixroom', item: item.n },
                  display: `fixroom (item ${item.n})`,
                  targets: [
                    {
                      key: `m${item.n}a`,
                      ref: { room: 'fixroom', item: item.n, msg: 'a' },
                      display: `fixroom (thread on message a)`,
                    },
                    {
                      key: `m${item.n}b`,
                      ref: { room: 'fixroom', item: item.n, msg: 'b' },
                      display: `fixroom (thread on message b)`,
                    },
                  ],
                },
              },
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
        },
      ],
      tools: [
        {
          name: 'sender_last_ctx',
          description: 'reports the SenderContext seen by the last send',
          inputSchema: { type: 'object' },
          call: async () => ({ ctx: lastCtx === undefined ? null : lastCtx }),
        },
        {
          name: 'sender_last_intent',
          description:
            'reports the SendIntent seen by the last send, and how many ' +
            'sends have happened',
          inputSchema: { type: 'object' },
          call: async () => ({
            intent: lastIntent === undefined ? null : lastIntent,
            sends: stats.sends,
          }),
        },
      ],
      senders: {
        fixsrc: {
          send: async (intent, ctx) => {
            lastCtx = ctx === undefined ? null : ctx;
            lastIntent = intent === undefined ? null : intent;
            stats.sends += 1;
            return { externalMessageId: 'fix-1' };
          },
        },
      },
    };
  },
};
