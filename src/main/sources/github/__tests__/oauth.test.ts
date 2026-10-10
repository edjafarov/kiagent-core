import { githubOAuthProfile, githubRefresher } from '../oauth';

// Build-time DefinePlugin injects these; under jest nothing inlines them.
process.env.GITHUB_OAUTH_CLIENT_ID = 'gh-test-client';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh-test-secret';

const REDIRECT_URI = 'http://127.0.0.1:34123/oauth/callback';

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stateFrom(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get('state');
  if (!state) throw new Error('authUrl produced no state param');
  return state;
}

describe('github oauth profile', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the fixed loopback redirect', () => {
    expect(githubOAuthProfile.redirectUri).toBe(REDIRECT_URI);
  });

  it('authUrl carries client_id, scopes, state and an S256 challenge', () => {
    const url = new URL(
      githubOAuthProfile.authUrl(['repo', 'read:project'], REDIRECT_URI),
    );
    expect(url.origin + url.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('gh-test-client');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('repo read:project');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('allow_signup')).toBe('false');
  });

  it('exchange posts code + verifier + secret asking for JSON and maps the token', async () => {
    const state = stateFrom(githubOAuthProfile.authUrl(['repo'], REDIRECT_URI));
    const fetchSpy = jest.fn(async (_input: unknown, _init?: RequestInit) =>
      okJson({
        access_token: 'gho_x',
        scope: 'repo,read:org',
        token_type: 'bearer',
      }),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;
    const creds = await githubOAuthProfile.exchange(
      `${REDIRECT_URI}?code=abc&state=${state}`,
      REDIRECT_URI,
    );
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect((init!.headers as Record<string, string>).Accept).toBe(
      'application/json',
    );
    const body = new URLSearchParams(String(init!.body));
    expect(body.get('client_id')).toBe('gh-test-client');
    expect(body.get('client_secret')).toBe('gh-test-secret');
    expect(body.get('code')).toBe('abc');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('code_verifier')).toBeTruthy();
    expect(creds).toEqual({
      accessToken: 'gho_x',
      clientId: 'gh-test-client',
      scope: 'repo,read:org',
    });
  });

  it('an HTTP 200 error body throws', async () => {
    const state = stateFrom(githubOAuthProfile.authUrl(['repo'], REDIRECT_URI));
    global.fetch = jest.fn(async () =>
      okJson({ error: 'bad_verification_code', error_description: 'expired' }),
    ) as unknown as typeof fetch;
    await expect(
      githubOAuthProfile.exchange(
        `${REDIRECT_URI}?code=abc&state=${state}`,
        REDIRECT_URI,
      ),
    ).rejects.toThrow(/bad_verification_code/);
  });

  it('a state mismatch throws without calling the token endpoint', async () => {
    githubOAuthProfile.authUrl(['repo'], REDIRECT_URI);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      githubOAuthProfile.exchange(
        `${REDIRECT_URI}?code=abc&state=nope`,
        REDIRECT_URI,
      ),
    ).rejects.toThrow(/state mismatch/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a callback error is surfaced', async () => {
    githubOAuthProfile.authUrl(['repo'], REDIRECT_URI);
    await expect(
      githubOAuthProfile.exchange(
        `${REDIRECT_URI}?error=access_denied&error_description=denied`,
        REDIRECT_URI,
      ),
    ).rejects.toThrow(/access_denied/);
  });

  it('the refresher returns null (tokens never expire)', async () => {
    expect(await githubRefresher({ accessToken: 'x' })).toBeNull();
  });
});
