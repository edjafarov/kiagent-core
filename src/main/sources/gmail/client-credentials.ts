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

export interface OAuthClientCreds {
  clientId: string;
  clientSecret: string;
}

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
