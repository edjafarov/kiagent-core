// Microsoft Entra ID (Azure AD) public-client OAuth registration, shared by
// every Microsoft Graph connector (OneDrive, Microsoft 365 mail). The app
// authenticates as a PKCE public client — there is NO client secret, unlike
// the Google client-credentials module.
//
// The client id is injected at BUILD time from the environment (webpack
// DefinePlugin inlines MICROSOFT_OAUTH_CLIENT_ID into the main-process
// bundle) — nothing is hardcoded in the repo. Local builds read it from a
// git-ignored .env file (see .env.example); CI reads it from repository
// secrets. Use the same Entra app registration the legacy app bundled so
// existing users don't have to re-consent to a new app.

export interface MicrosoftClientCreds {
  clientId: string;
}

export function getMicrosoftClientCredentials(): MicrosoftClientCreds {
  const clientId = process.env.MICROSOFT_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'this build has no Microsoft OAuth client id — set ' +
        'MICROSOFT_OAUTH_CLIENT_ID in .env (local builds) or repository ' +
        'secrets (CI) and rebuild',
    );
  }
  return { clientId };
}
