/**
 * Platform-side OAuth provider registry for extension-contributed sources.
 * A manifest entry `{ id, oauth: 'google' }` binds that source id to the
 * provider's profile (connect-time auth window + token exchange) and
 * refresher (token refresh before pull) — the extension itself never
 * touches client credentials.
 */
import type { Credentials, OAuthProviderId } from '@shared/contracts';

import type { OAuthProfile } from '@main/auth/oauth-window';
import { googleOAuthProfile, googleRefresher } from '@main/sources/gmail/oauth';
import {
  microsoftOAuthProfile,
  microsoftRefresher,
} from '@main/sources/microsoft/oauth';

export interface OAuthProviderBinding {
  profile: OAuthProfile;
  refresher(creds: Credentials): Promise<Credentials | null>;
}

/** Keyed by the manifest's `oauth` value — the Record<OAuthProviderId, …>
 *  shape fails compile if the shared union and this registry ever drift. */
export const oauthProviders: Record<OAuthProviderId, OAuthProviderBinding> = {
  google: { profile: googleOAuthProfile, refresher: googleRefresher },
  microsoft: { profile: microsoftOAuthProfile, refresher: microsoftRefresher },
};
