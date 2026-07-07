/**
 * Fixture for the oauth-bound source contribution: the manifest declares
 * `{ id: 'oauthsrc', oauth: 'google' }`, so activating this extension must
 * register the platform's Google OAuth profile + refresher under 'oauthsrc'.
 * The credentials below are OBVIOUS FAKES — never real tokens.
 */
module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'oauthsrc',
            name: 'OAuth Source',
            documentTypes: ['oauth.item'],
            auth: 'oauth',
          },
          async connect(auth) {
            // Offline tests never drive this; a real connect would call
            // auth.oauth(scopes) and persist the returned credentials.
            void auth;
            return {
              identifier: 'oauth-account',
              config: {},
              credentials: { accessToken: 'FAKE-TEST-TOKEN-NOT-REAL' },
            };
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
              externalId: `oauth-${item.n}`,
              type: 'oauth.item',
              title: `OAuth doc ${item.n}`,
              markdown: `body ${item.n}`,
              metadata: {},
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
        },
      ],
      tools: [],
    };
  },
};
