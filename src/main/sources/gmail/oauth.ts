import crypto from 'node:crypto';

import type { Credentials } from '@shared/contracts';
import { SourceAuthError } from '@shared/source-errors';

import type { OAuthProfile } from '../../auth/oauth-window';
import { getGoogleClientCredentials } from './client-credentials';

/**
 * Gmail read-only scope — identical to legacy
 * (kiagent-ref src/main/connectors/gmail/oauth.ts GMAIL_SCOPES). Only the
 * gmail.readonly scope is requested; this port does not do the combined
 * identity+gmail single-consent flow the legacy app offered during sign-in.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Loopback redirect URI. NOT a secret — it is a registered redirect string
 * on the Google OAuth client, never actually listened on. Matches legacy
 * exactly (kiagent-ref oauth-shared/capture-auth-code.ts REDIRECT_URI) so the
 * existing Google Cloud OAuth client config (authorized redirect URIs) stays
 * valid without needing to be updated.
 */
const REDIRECT_URI = 'http://127.0.0.1:34123/oauth/callback';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

function deriveCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function expiresAtFrom(expiresInSeconds: number | undefined): string {
  const seconds = expiresInSeconds ?? 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function postToken(
  params: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || body.error) {
    const message = `gmail oauth token request failed: ${body.error ?? res.status}${body.error_description ? ` — ${body.error_description}` : ''}`;
    // invalid_grant = the refresh token itself is revoked/expired — retrying
    // can never succeed. The engine maps the 'auth' code to 'needsReauth'.
    throw body.error === 'invalid_grant'
      ? new SourceAuthError(message)
      : new Error(message);
  }
  return body;
}

/**
 * `OAuthProfile` is a two-phase API (authUrl, then exchange) with no way to
 * thread state between the calls — so the PKCE code_verifier and the
 * anti-CSRF state param generated in `authUrl` are held here in module
 * closure state, consumed (and cleared) by the following `exchange` call.
 * Same single-pending-flow stance as microsoft/oauth.ts: only one Gmail auth
 * window runs at a time (UI-enforced, not broker-enforced), and a second
 * concurrent `authUrl` call would clobber this one's pending verifier/state —
 * the loser fails safe on the state-mismatch throw.
 */
let pending: { codeVerifier: string; state: string } | null = null;

/**
 * `OAuthProfile` for Google/Gmail. `authUrl` is a pure URL builder (no
 * network); `exchange` performs the authorization_code grant directly
 * against Google's token endpoint per the task brief, rather than going
 * through `google-auth-library`'s OAuth2Client — keeps this module's only
 * dependency on the client secret confined to the moment of exchange.
 *
 * The returned Credentials embed clientId/clientSecret so `googleRefresher`
 * (refresh.ts) can refresh later WITHOUT importing client-credentials.ts —
 * the app id/secret ride the vault alongside the tokens, exactly as
 * `Credentials.clientId`/`clientSecret` are documented to do in contracts.ts.
 */
export const googleOAuthProfile: OAuthProfile = {
  redirectUri: REDIRECT_URI,

  authUrl(scopes: string[], redirectUri: string): string {
    const { clientId } = getGoogleClientCredentials();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');
    pending = { codeVerifier, state };

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    // access_type=offline + prompt=consent: forces Google to (re)issue a
    // refresh_token every time, matching legacy oauth-store.ts exactly —
    // without `prompt=consent` a previously-authorized user gets no
    // refresh_token on repeat connects.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
  },

  async exchange(
    callbackUrl: string,
    redirectUri: string,
  ): Promise<Credentials> {
    const cb = new URL(callbackUrl);
    const error = cb.searchParams.get('error');
    if (error) {
      pending = null;
      const desc = cb.searchParams.get('error_description');
      throw new Error(`gmail oauth error: ${error}${desc ? ` — ${desc}` : ''}`);
    }
    const code = cb.searchParams.get('code');
    if (!code) {
      pending = null;
      throw new Error('gmail oauth callback missing code');
    }

    const current = pending;
    pending = null;
    if (!current) {
      throw new Error(
        'gmail oauth exchange called with no pending authUrl request',
      );
    }
    if (cb.searchParams.get('state') !== current.state) {
      throw new Error('gmail oauth state mismatch — possible CSRF, aborting');
    }

    const { clientId, clientSecret } = getGoogleClientCredentials();
    const body = await postToken({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: current.codeVerifier,
    });
    if (!body.refresh_token) {
      throw new Error(
        "gmail oauth: no refresh_token returned — try removing the app from the Google account's connected-apps list and reconnecting.",
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: expiresAtFrom(body.expires_in),
      clientId,
      clientSecret,
    };
  },
};

/**
 * Refresh-token grant. Reads clientId/clientSecret off the passed-in
 * Credentials (vault-persisted at connect time) — deliberately does NOT
 * import client-credentials.ts, so refresh works even if the bundled/env
 * client credentials aren't loaded in whatever process runs the refresh.
 */
export async function googleRefresher(
  creds: Credentials,
): Promise<Credentials | null> {
  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret)
    return null;
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  return {
    ...creds,
    accessToken: body.access_token,
    // Google usually omits refresh_token on refresh grants — keep the
    // existing one (matches legacy google-shared/refresh.ts).
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: expiresAtFrom(body.expires_in),
  };
}
