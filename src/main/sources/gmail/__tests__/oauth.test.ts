import crypto from 'node:crypto';

import type { Credentials } from '@shared/contracts';

import { GMAIL_SCOPES, googleOAuthProfile, googleRefresher } from '../oauth';

// The client id/secret are build-time env injects (webpack DefinePlugin);
// under jest nothing inlines them, so getGoogleClientCredentials() reads the
// real process.env and would throw without these fakes. Obviously-fake
// values only — never real OAuth secrets.
process.env.GOOGLE_OAUTH_CLIENT_ID = 'gmail-test-client-id-deadbeef';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gmail-test-client-secret-cafef00d';

const REDIRECT_URI = 'http://127.0.0.1:34123/oauth/callback';

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function errJson(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as Response;
}

/** Grabs the `state` param authUrl generated, so a matching callback can be
 *  built (exchange consumes/clears the pending PKCE state either way). */
function stateFrom(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get('state');
  if (!state) throw new Error('authUrl produced no state param');
  return state;
}

/** S256 PKCE transform — mirrors oauth.ts's private `deriveCodeChallenge`,
 *  so a test can prove a posted `code_verifier` really is the preimage of a
 *  given authUrl's `code_challenge`, not merely "different from some other
 *  verifier" (which a verifier SWAP between two flows would also satisfy). */
function codeChallengeFrom(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

describe('gmail oauth profile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('authUrl', () => {
    it('contains client_id, an S256 PKCE challenge, state, access_type=offline, prompt=consent, and the redirect_uri', () => {
      const url = new URL(
        googleOAuthProfile.authUrl(
          ['https://www.googleapis.com/auth/gmail.readonly'],
          REDIRECT_URI,
        ),
      );
      expect(url.searchParams.get('client_id')).toBeTruthy();
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('state')).toBeTruthy();

      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain('gmail.readonly');
    });
  });

  describe('exchange', () => {
    // Each test gets a FRESH module instance — jest.resetModules() plus a
    // dynamic re-require — so its `pending` map starts genuinely empty on
    // its own merits. Previously the "no pending" test manufactured an
    // empty map via "authUrl, then an errored exchange with no state",
    // relying on production's clear-all behavior as a side-channel test
    // reset; that made a test convenience the thing exercising/justifying
    // shipping behavior. Real isolation removes that coupling — the
    // clear-all path (see dropUnfinishable in oauth.ts) is still covered
    // directly by the "callback URL carries an error param" test above,
    // which itself resets per-test now too.
    let oauth: typeof import('../oauth');

    beforeEach(() => {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      oauth = require('../oauth');
    });

    it('happy path: sends the code_verifier from the preceding authUrl call and returns Credentials with clientId/clientSecret', async () => {
      const authUrl = oauth.googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const state = stateFrom(authUrl);

      let sentBody = '';
      global.fetch = jest.fn(async (_input, init) => {
        sentBody = String(init?.body ?? '');
        return okJson({
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expires_in: 3600,
        });
      }) as unknown as typeof fetch;

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=${state}`;
      const creds = await oauth.googleOAuthProfile.exchange(
        callback,
        REDIRECT_URI,
      );

      expect(creds).toEqual({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: expect.any(String),
        clientId: expect.any(String),
        clientSecret: expect.any(String),
      });

      const sentParams = new URLSearchParams(sentBody);
      expect(sentParams.get('grant_type')).toBe('authorization_code');
      expect(sentParams.get('code')).toBe('fake-auth-code');
      expect(sentParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(sentParams.get('code_verifier')).toBeTruthy();
    });

    it('throws when the callback URL carries an error param', async () => {
      oauth.googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const callback = `${REDIRECT_URI}?error=access_denied&error_description=user+cancelled`;
      await expect(
        oauth.googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/access_denied/);
    });

    it('throws when the token response is missing refresh_token', async () => {
      const authUrl = oauth.googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const state = stateFrom(authUrl);
      global.fetch = jest.fn(async () =>
        okJson({ access_token: 'fake-access-token', expires_in: 3600 }),
      ) as unknown as typeof fetch;

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=${state}`;
      await expect(
        oauth.googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/refresh_token/);
    });

    it('throws on a state mismatch (possible CSRF)', async () => {
      oauth.googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=not-the-right-state`;
      await expect(
        oauth.googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/state mismatch/);
    });

    it('throws when exchange is called with no pending authUrl request', async () => {
      // Fresh module (see beforeEach) — `pending` starts empty on its own,
      // no authUrl call and no reliance on any clear-all side effect.
      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=whatever`;
      await expect(
        oauth.googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/no pending authUrl request/);
    });
  });

  describe('googleRefresher', () => {
    const baseCreds: Credentials = {
      accessToken: 'old-access-token',
      refreshToken: 'fake-refresh-token',
      clientId: 'fake-client-id',
      clientSecret: 'fake-client-secret',
      expiresAt: new Date(0).toISOString(),
    };

    it('happy path: refreshes and sends client_secret', async () => {
      let sentBody = '';
      global.fetch = jest.fn(async (_input, init) => {
        sentBody = String(init?.body ?? '');
        return okJson({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        });
      }) as unknown as typeof fetch;

      const result = await googleRefresher(baseCreds);
      expect(result).toEqual({
        ...baseCreds,
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: expect.any(String),
      });

      const sentParams = new URLSearchParams(sentBody);
      expect(sentParams.get('grant_type')).toBe('refresh_token');
      expect(sentParams.get('client_id')).toBe('fake-client-id');
      expect(sentParams.get('client_secret')).toBe('fake-client-secret');
    });

    it('falls back to the previous refreshToken when Google does not rotate it', async () => {
      global.fetch = jest.fn(async () =>
        okJson({ access_token: 'new-access-token', expires_in: 3600 }),
      ) as unknown as typeof fetch;

      const result = await googleRefresher(baseCreds);
      expect(result?.refreshToken).toBe('fake-refresh-token');
    });

    it('returns null when refreshToken, clientId, or clientSecret is missing', async () => {
      await expect(
        googleRefresher({ ...baseCreds, refreshToken: undefined }),
      ).resolves.toBeNull();
      await expect(
        googleRefresher({ ...baseCreds, clientId: undefined }),
      ).resolves.toBeNull();
      await expect(
        googleRefresher({ ...baseCreds, clientSecret: undefined }),
      ).resolves.toBeNull();
    });

    it('throws on a failed refresh request', async () => {
      global.fetch = jest.fn(async () =>
        errJson(400, { error: 'invalid_grant' }),
      ) as unknown as typeof fetch;
      await expect(googleRefresher(baseCreds)).rejects.toThrow(/invalid_grant/);
    });
  });

  describe('client override', () => {
    const OVERRIDE = { clientId: 'byo-id', clientSecret: 'byo-secret' };

    it('authUrl uses the override client_id instead of the env client', () => {
      const url = new URL(
        googleOAuthProfile.authUrl(
          ['https://www.googleapis.com/auth/gmail.readonly'],
          REDIRECT_URI,
          OVERRIDE,
        ),
      );
      expect(url.searchParams.get('client_id')).toBe('byo-id');
    });

    it('exchange posts the override client and embeds it in the returned Credentials', async () => {
      const authUrl = googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
        OVERRIDE,
      );
      const state = stateFrom(authUrl);

      let sentBody = '';
      global.fetch = jest.fn(async (_input, init) => {
        sentBody = String(init?.body ?? '');
        return okJson({
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expires_in: 3600,
        });
      }) as unknown as typeof fetch;

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=${state}`;
      const creds = await googleOAuthProfile.exchange(callback, REDIRECT_URI);

      const sentParams = new URLSearchParams(sentBody);
      expect(sentParams.get('client_id')).toBe('byo-id');
      expect(sentParams.get('client_secret')).toBe('byo-secret');
      expect(creds.clientId).toBe('byo-id');
      expect(creds.clientSecret).toBe('byo-secret');
    });

    it('two interleaved flows do not clobber each other (pending keyed by state)', async () => {
      const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
      const urlA = new URL(
        googleOAuthProfile.authUrl(scopes, REDIRECT_URI, OVERRIDE),
      );
      const urlB = new URL(googleOAuthProfile.authUrl(scopes, REDIRECT_URI)); // env client
      const stateA = stateFrom(urlA.toString());
      const stateB = stateFrom(urlB.toString());
      const challengeA = urlA.searchParams.get('code_challenge');
      const challengeB = urlB.searchParams.get('code_challenge');
      if (!challengeA || !challengeB) {
        throw new Error('authUrl produced no code_challenge param');
      }

      global.fetch = jest.fn(async () =>
        okJson({
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expires_in: 3600,
        }),
      ) as unknown as typeof fetch;

      // Exchange B first, then A — both must succeed with their OWN
      // verifier+client.
      const credsB = await googleOAuthProfile.exchange(
        `${REDIRECT_URI}?code=fake-auth-code&state=${stateB}`,
        REDIRECT_URI,
      );
      const credsA = await googleOAuthProfile.exchange(
        `${REDIRECT_URI}?code=fake-auth-code&state=${stateA}`,
        REDIRECT_URI,
      );
      expect(credsA.clientId).toBe('byo-id');
      expect(credsB.clientId).not.toBe('byo-id');

      // Verifier isolation, proven properly: each exchange's posted
      // code_verifier must hash (S256) back to ITS OWN authUrl's
      // code_challenge — not merely "differs from the other one", which a
      // verifier SWAP between the two flows would also satisfy.
      const verifierB = new URLSearchParams(
        (global.fetch as jest.Mock).mock.calls[0][1].body as string,
      ).get('code_verifier');
      const verifierA = new URLSearchParams(
        (global.fetch as jest.Mock).mock.calls[1][1].body as string,
      ).get('code_verifier');
      if (!verifierA || !verifierB) {
        throw new Error('exchange posted no code_verifier');
      }
      expect(codeChallengeFrom(verifierB)).toBe(challengeB);
      expect(codeChallengeFrom(verifierA)).toBe(challengeA);
    });
  });

  describe('scope', () => {
    it('requests exactly readonly + send (pinned — scope drift must be loud)', () => {
      expect(GMAIL_SCOPES).toEqual([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ]);
    });

    it('exchange persists the granted scope string', async () => {
      const authUrl = googleOAuthProfile.authUrl(GMAIL_SCOPES, REDIRECT_URI);
      const state = stateFrom(authUrl);

      global.fetch = jest.fn(async () =>
        okJson({
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        }),
      ) as unknown as typeof fetch;

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=${state}`;
      const creds = await googleOAuthProfile.exchange(callback, REDIRECT_URI);

      expect(creds.scope).toBe(
        'https://www.googleapis.com/auth/gmail.readonly',
      );
    });

    it('googleRefresher persists the granted scope string, falling back to the existing scope when Google omits it', async () => {
      const baseCreds: Credentials = {
        accessToken: 'old-access-token',
        refreshToken: 'fake-refresh-token',
        clientId: 'fake-client-id',
        clientSecret: 'fake-client-secret',
        expiresAt: new Date(0).toISOString(),
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      };

      global.fetch = jest.fn(async () =>
        okJson({
          access_token: 'new-access-token',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
        }),
      ) as unknown as typeof fetch;

      const result = await googleRefresher(baseCreds);
      expect(result?.scope).toBe(
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
      );

      global.fetch = jest.fn(async () =>
        okJson({ access_token: 'new-access-token-2', expires_in: 3600 }),
      ) as unknown as typeof fetch;

      const fallback = await googleRefresher(baseCreds);
      expect(fallback?.scope).toBe(baseCreds.scope);
    });
  });
});
