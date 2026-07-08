import type { Credentials } from '@shared/contracts';

import { googleOAuthProfile, googleRefresher } from '../oauth';

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
    it('happy path: sends the code_verifier from the preceding authUrl call and returns Credentials with clientId/clientSecret', async () => {
      const authUrl = googleOAuthProfile.authUrl(
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
      const creds = await googleOAuthProfile.exchange(callback, REDIRECT_URI);

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
      googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const callback = `${REDIRECT_URI}?error=access_denied&error_description=user+cancelled`;
      await expect(
        googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/access_denied/);
    });

    it('throws when the token response is missing refresh_token', async () => {
      const authUrl = googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const state = stateFrom(authUrl);
      global.fetch = jest.fn(async () =>
        okJson({ access_token: 'fake-access-token', expires_in: 3600 }),
      ) as unknown as typeof fetch;

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=${state}`;
      await expect(
        googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/refresh_token/);
    });

    it('throws on a state mismatch (possible CSRF)', async () => {
      googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=not-the-right-state`;
      await expect(
        googleOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/state mismatch/);
    });

    it('throws when exchange is called with no pending authUrl request', async () => {
      // Ensure no pending flow is outstanding regardless of prior test
      // order: an authUrl call followed by an errored exchange clears the
      // module-closure `pending` as a side effect (same as the
      // callback-carries-error path above), leaving it empty for the real
      // assertion below.
      googleOAuthProfile.authUrl(
        ['https://www.googleapis.com/auth/gmail.readonly'],
        REDIRECT_URI,
      );
      await googleOAuthProfile
        .exchange(`${REDIRECT_URI}?error=user_cancelled`, REDIRECT_URI)
        .catch(() => {});

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=whatever`;
      await expect(
        googleOAuthProfile.exchange(callback, REDIRECT_URI),
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
});
