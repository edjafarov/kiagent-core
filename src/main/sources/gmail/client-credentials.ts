// Google OAuth client credentials shared by every Google connector (Gmail,
// Google Docs). These identify the *application* to Google (an "installed
// app" OAuth client), not the end user.
//
// The values are injected at BUILD time from the environment (webpack
// DefinePlugin inlines GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
// into the main-process bundle) — nothing is hardcoded in the repo. Local
// builds read them from a git-ignored .env file (see .env.example); CI reads
// them from repository secrets. Google's docs note an installed-app client
// secret is not a secret in the security sense — keeping it out of the repo
// is source hygiene, not runtime protection.

import type { OAuthClientOverride } from '../../auth/oauth-window';

/** Structurally identical to `OAuthClientOverride` (oauth-window.ts) — this
 *  IS that type, aliased under the name this module's callers already use.
 *  One shape, one name each in each file: oauth-window.ts stays free of
 *  any gmail-specific import (it defines the shape), this module just
 *  renames it for its own local vocabulary ("credentials", not "override" —
 *  every value here, override or env-sourced, is a client credentials
 *  pair). */
export type OAuthClientCreds = OAuthClientOverride;

export function getGoogleClientCredentials(): OAuthClientCreds {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'this build has no Google OAuth client credentials — set ' +
        'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env ' +
        '(local builds) or repository secrets (CI) and rebuild',
    );
  }
  return { clientId, clientSecret };
}
