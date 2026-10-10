// GitHub OAuth App registration (kia-plugins "Kia" app) used by the GitHub
// extension source. Unlike the Microsoft public client, GitHub's OAuth App
// token exchange REQUIRES a client secret even with PKCE — like Google's
// installed-app client, the secret ships inside the desktop bundle and is not
// a secret in the security sense.
//
// Both values are injected at BUILD time from the environment (webpack
// DefinePlugin, see .erb/configs/oauth-env.ts) — nothing is hardcoded in the
// repo. Local builds read them from a git-ignored .env; CI from repository
// secrets.

export interface GitHubClientCreds {
  clientId: string;
  clientSecret: string;
}

export function getGitHubClientCredentials(): GitHubClientCreds {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'this build has no GitHub OAuth client credentials — set ' +
        'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET in .env ' +
        '(local builds) or repository secrets (CI) and rebuild',
    );
  }
  return { clientId, clientSecret };
}
