/**
 * Fixture for the CROSS-BUNDLE half of the source-error taxonomy: its pull()
 * throws a PLAIN Error carrying `code: 'auth'`, never a SourceAuthError.
 *
 * That is not a shortcut — it is the contract. An extension is a separately
 * bundled CJS module with its own copy (or no copy) of source-errors.ts, so
 * class identity cannot survive the boundary and `instanceof` is unavailable
 * by construction. The `code` property is the entire wire contract: the
 * child forwards it on `src-error`, source-proxy rehydrates a plain Error
 * with it, and the engine must reach 'needsReauth' from that alone.
 */
module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'authfailsrc',
            name: 'Auth Failure Source',
            documentTypes: ['authfail.item'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'authfail-account', config: {} };
          },
          // eslint-disable-next-line require-yield
          async *pull() {
            throw Object.assign(new Error('fixture 401 — token revoked'), {
              code: 'auth',
            });
          },
          toDocument() {
            return null;
          },
        },
      ],
    };
  },
};
