import type { Credentials } from '@shared/contracts';

import { microsoftOAuthProfile, microsoftRefresher } from '../oauth';

// The client id is a build-time env inject (webpack DefinePlugin); under
// jest nothing inlines it, so getMicrosoftClientCredentials() reads the real
// process.env and would throw without this fake.
process.env.MICROSOFT_OAUTH_CLIENT_ID = 'ms-test-client-id-deadbeef';

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

describe('microsoft oauth profile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('authUrl', () => {
    it('contains client_id, an S256 PKCE challenge, offline_access, prompt=select_account, and the redirect_uri', () => {
      const url = new URL(
        microsoftOAuthProfile.authUrl(
          ['Files.Read.All', 'User.Read'],
          REDIRECT_URI,
        ),
      );
      expect(url.searchParams.get('client_id')).toBeTruthy();
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('prompt')).toBe('select_account');

      const scope = url.searchParams.get('scope') ?? '';
      expect(scope).toContain('Files.Read.All');
      expect(scope).toContain('User.Read');
      expect(scope).toContain('offline_access');
      expect(scope).not.toContain('openid');
    });
  });

  describe('exchange', () => {
    it('happy path: sends the code_verifier from the preceding authUrl call and returns Credentials with no clientSecret', async () => {
      const authUrl = microsoftOAuthProfile.authUrl(
        ['Files.Read.All'],
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
      const creds = await microsoftOAuthProfile.exchange(
        callback,
        REDIRECT_URI,
      );

      expect(creds).toEqual({
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: expect.any(String),
        clientId: expect.any(String),
      });
      expect(creds).not.toHaveProperty('clientSecret');

      const sentParams = new URLSearchParams(sentBody);
      expect(sentParams.get('grant_type')).toBe('authorization_code');
      expect(sentParams.get('code')).toBe('fake-auth-code');
      expect(sentParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(sentParams.get('code_verifier')).toBeTruthy();
      expect(sentParams.has('client_secret')).toBe(false);
    });

    it('throws when the callback URL carries an error param', async () => {
      microsoftOAuthProfile.authUrl(['Files.Read.All'], REDIRECT_URI);
      const callback = `${REDIRECT_URI}?error=access_denied&error_description=user+cancelled`;
      await expect(
        microsoftOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/access_denied/);
    });

    it('throws when the token response is missing refresh_token', async () => {
      const authUrl = microsoftOAuthProfile.authUrl(
        ['Files.Read.All'],
        REDIRECT_URI,
      );
      const state = stateFrom(authUrl);
      global.fetch = jest.fn(async () =>
        okJson({ access_token: 'fake-access-token', expires_in: 3600 }),
      ) as unknown as typeof fetch;

      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=${state}`;
      await expect(
        microsoftOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/refresh_token/);
    });

    it('throws on a state mismatch (possible CSRF)', async () => {
      microsoftOAuthProfile.authUrl(['Files.Read.All'], REDIRECT_URI);
      const callback = `${REDIRECT_URI}?code=fake-auth-code&state=not-the-right-state`;
      await expect(
        microsoftOAuthProfile.exchange(callback, REDIRECT_URI),
      ).rejects.toThrow(/state mismatch/);
    });
  });

  describe('microsoftRefresher', () => {
    const baseCreds: Credentials = {
      accessToken: 'old-access-token',
      refreshToken: 'fake-refresh-token',
      clientId: 'fake-client-id',
      expiresAt: new Date(0).toISOString(),
    };

    it('happy path: refreshes without sending client_secret', async () => {
      let sentBody = '';
      global.fetch = jest.fn(async (_input, init) => {
        sentBody = String(init?.body ?? '');
        return okJson({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        });
      }) as unknown as typeof fetch;

      const result = await microsoftRefresher(baseCreds);
      expect(result).toEqual({
        ...baseCreds,
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: expect.any(String),
      });

      const sentParams = new URLSearchParams(sentBody);
      expect(sentParams.get('grant_type')).toBe('refresh_token');
      expect(sentParams.get('client_id')).toBe('fake-client-id');
      expect(sentParams.has('client_secret')).toBe(false);
    });

    it('falls back to the previous refreshToken when Microsoft does not rotate it', async () => {
      global.fetch = jest.fn(async () =>
        okJson({ access_token: 'new-access-token', expires_in: 3600 }),
      ) as unknown as typeof fetch;

      const result = await microsoftRefresher(baseCreds);
      expect(result?.refreshToken).toBe('fake-refresh-token');
    });

    it('returns null when refreshToken or clientId is missing', async () => {
      await expect(
        microsoftRefresher({ ...baseCreds, refreshToken: undefined }),
      ).resolves.toBeNull();
      await expect(
        microsoftRefresher({ ...baseCreds, clientId: undefined }),
      ).resolves.toBeNull();
    });

    it('throws on a failed refresh request (matches googleRefresher failure semantics)', async () => {
      global.fetch = jest.fn(async () =>
        errJson(400, { error: 'invalid_grant' }),
      ) as unknown as typeof fetch;
      await expect(microsoftRefresher(baseCreds)).rejects.toThrow(
        /invalid_grant/,
      );
    });
  });
});
