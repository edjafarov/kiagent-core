import crypto from 'node:crypto';

import type { Credentials } from '@shared/contracts';

import type { OAuthProfile } from '../../auth/oauth-window';
import { getGitHubClientCredentials } from './client-credentials';

/**
 * Loopback redirect URI sent to GitHub. The OAuth App's registered callback
 * is `http://127.0.0.1/oauth/callback` (no port): GitHub accepts any port on
 * a loopback callback, so this matches the other providers' fixed URI.
 */
const REDIRECT_URI = 'http://127.0.0.1:34123/oauth/callback';

const AUTH_ENDPOINT = 'https://github.com/login/oauth/authorize';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';

interface GitHubTokenResponse {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * PKCE verifier + anti-CSRF state held between `authUrl` and `exchange`.
 * Same single-flow INVARIANT as microsoft/oauth.ts: only one GitHub auth
 * window runs at a time (UI-enforced); a concurrent second `authUrl` call
 * clobbers the first flow, which then fails safe on the state mismatch.
 */
let pending: { codeVerifier: string; state: string } | null = null;

/**
 * `OAuthProfile` for the GitHub extension source: an OAuth App web flow
 * with PKCE (S256) plus the client secret GitHub requires. OAuth App tokens
 * never expire and carry no refresh token, so the returned Credentials have
 * no `expiresAt` — `freshCredentials` therefore never calls the refresher.
 */
export const githubOAuthProfile: OAuthProfile = {
  redirectUri: REDIRECT_URI,

  authUrl(scopes: string[], redirectUri: string): string {
    const { clientId } = getGitHubClientCredentials();
    const codeVerifier = base64url(crypto.randomBytes(32));
    const state = crypto.randomBytes(16).toString('hex');
    pending = { codeVerifier, state };

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set(
      'code_challenge',
      base64url(crypto.createHash('sha256').update(codeVerifier).digest()),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  },

  async exchange(
    callbackUrl: string,
    redirectUri: string,
  ): Promise<Credentials> {
    const cb = new URL(callbackUrl);
    const current = pending;
    pending = null;
    const error = cb.searchParams.get('error');
    if (error) {
      const desc = cb.searchParams.get('error_description');
      throw new Error(
        `github oauth error: ${error}${desc ? ` — ${desc}` : ''}`,
      );
    }
    const code = cb.searchParams.get('code');
    if (!code) throw new Error('github oauth callback missing code');
    if (!current) {
      throw new Error(
        'github oauth exchange called with no pending authUrl request',
      );
    }
    if (cb.searchParams.get('state') !== current.state) {
      throw new Error('github oauth state mismatch — possible CSRF, aborting');
    }

    const { clientId, clientSecret } = getGitHubClientCredentials();
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        // Without this GitHub answers form-encoded.
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: current.codeVerifier,
      }).toString(),
    });
    const body = (await res.json()) as GitHubTokenResponse;
    // GitHub reports token errors as HTTP 200 + an `error` field.
    if (!res.ok || body.error || !body.access_token) {
      throw new Error(
        `github oauth token request failed: ${body.error ?? res.status}${body.error_description ? ` — ${body.error_description}` : ''}`,
      );
    }
    // GitHub reports scopes comma-separated; Credentials.scope is space-separated.
    return {
      accessToken: body.access_token,
      clientId,
      scope: body.scope?.split(',').filter(Boolean).join(' '),
    };
  },
};

/** OAuth App tokens never expire, so there is nothing to refresh. Required
 *  only by the Record<OAuthProviderId, …> registry shape. */
export async function githubRefresher(
  _creds: Credentials,
): Promise<Credentials | null> {
  return null;
}
