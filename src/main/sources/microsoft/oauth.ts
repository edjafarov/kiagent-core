import crypto from 'node:crypto';

import type { Credentials } from '@shared/contracts';
import { SourceAuthError } from '@shared/source-errors';

import type { OAuthProfile } from '../../auth/oauth-window';
import { getMicrosoftClientCredentials } from './client-credentials';

/**
 * Loopback redirect URI. NOT a secret — it is the redirect URI registered on
 * the Azure app, never actually listened on. Matches gmail's exactly (same
 * legacy port 34123 trick — see gmail/oauth.ts's REDIRECT_URI) and must NOT
 * be changed: it is the one baked into the existing Azure app registration.
 */
const REDIRECT_URI = 'http://127.0.0.1:34123/oauth/callback';

const AUTH_ENDPOINT =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_ENDPOINT =
  'https://login.microsoftonline.com/common/oauth2/v2.0/token';

interface MicrosoftTokenResponse {
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
): Promise<MicrosoftTokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json()) as MicrosoftTokenResponse;
  if (!res.ok || body.error) {
    const message = `microsoft oauth token request failed: ${body.error ?? res.status}${body.error_description ? ` — ${body.error_description}` : ''}`;
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
 * INVARIANT: only one Microsoft auth window runs at a time. This is
 * UI-enforced, not broker-enforced: connect-broker.ts has no lock, and this
 * profile object is a singleton shared by every microsoft-bound source — the
 * renderer's single AddSourcePanel flow is what keeps calls sequential. A
 * second concurrent `authUrl` call (e.g. a future non-UI entry point into
 * connect-broker.start) would clobber the first flow's pending
 * verifier/state; the loser fails safe on the state-mismatch throw.
 */
let pending: { codeVerifier: string; state: string } | null = null;

/**
 * `OAuthProfile` for Microsoft Graph connectors (OneDrive, Microsoft 365
 * mail). PKCE (S256) authorization-code flow against Entra ID's `/common`
 * (multi-tenant + personal accounts) endpoint — mirrors the protocol in
 * legacy's ms-shared/oauth.ts, minus the id_token/nonce machinery that
 * flow used for its combined sign-in+consent step (not needed here: this
 * port only ever does the add-a-Graph-account flow).
 *
 * Public client: the returned Credentials carry only `clientId`, no
 * `clientSecret` — `microsoftRefresher` below refreshes without one too.
 */
export const microsoftOAuthProfile: OAuthProfile = {
  redirectUri: REDIRECT_URI,

  authUrl(scopes: string[], redirectUri: string): string {
    const { clientId } = getMicrosoftClientCredentials();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');
    pending = { codeVerifier, state };

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    // offline_access is required for a refresh_token; appended here rather
    // than relied on from each connector's own scope list. Deliberately no
    // `openid`/id_token — this flow doesn't need an identity token.
    url.searchParams.set('scope', [...scopes, 'offline_access'].join(' '));
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
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
      throw new Error(
        `microsoft oauth error: ${error}${desc ? ` — ${desc}` : ''}`,
      );
    }
    const code = cb.searchParams.get('code');
    if (!code) {
      pending = null;
      throw new Error('microsoft oauth callback missing code');
    }

    const current = pending;
    pending = null;
    if (!current) {
      throw new Error(
        'microsoft oauth exchange called with no pending authUrl request',
      );
    }
    if (cb.searchParams.get('state') !== current.state) {
      throw new Error(
        'microsoft oauth state mismatch — possible CSRF, aborting',
      );
    }

    const { clientId } = getMicrosoftClientCredentials();
    const body = await postToken({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      code_verifier: current.codeVerifier,
      redirect_uri: redirectUri,
    });
    if (!body.refresh_token) {
      throw new Error(
        'microsoft oauth: no refresh_token returned — offline_access may not have been granted.',
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: expiresAtFrom(body.expires_in),
      clientId,
    };
  },
};

/**
 * Refresh-token grant. Reads clientId/refreshToken off the passed-in
 * Credentials (vault-persisted at connect time) — deliberately does NOT
 * import client-credentials.ts, matching googleRefresher's shape. No
 * client_secret is sent (public client). Same failure semantics as
 * googleRefresher: returns null only when the prerequisites are missing;
 * a failed token request (e.g. invalid_grant) throws via postToken.
 */
export async function microsoftRefresher(
  creds: Credentials,
): Promise<Credentials | null> {
  if (!creds.refreshToken || !creds.clientId) return null;
  const body = await postToken({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
  });
  return {
    ...creds,
    accessToken: body.access_token,
    // Microsoft doesn't always rotate the refresh_token on refresh — keep
    // the existing one when it doesn't (matches legacy ms-shared/oauth.ts
    // refreshAccessToken, and googleRefresher's equivalent fallback).
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: expiresAtFrom(body.expires_in),
  };
}
