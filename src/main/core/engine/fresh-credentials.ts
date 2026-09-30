/**
 * The one "give me usable credentials for this account" rule, shared by the
 * engine's `session.credentials()` and the extension send pipeline (an
 * out-of-process Sender has no vault of its own — the host hands it
 * credentials at send time, and an OAuth access token read raw from the
 * vault is expired an hour after the last sync refreshed it).
 */
import type { AccountId, Credentials } from '@shared/contracts';
import { sourceErrorCode } from '@shared/source-errors';

/** Refresh when the token expires within this margin. */
export const REFRESH_MARGIN_MS = 60_000;

export type Refresher = (creds: Credentials) => Promise<Credentials | null>;

export async function freshCredentials(deps: {
  vault: {
    load(account: AccountId): Promise<Credentials | null>;
    save(account: AccountId, creds: Credentials): Promise<void>;
  };
  account: AccountId;
  refresh: Refresher | undefined;
  warn(msg: string): void;
}): Promise<Credentials | null> {
  const creds = await deps.vault.load(deps.account);
  if (!creds) return null;
  const expiringSoon =
    creds.expiresAt !== undefined &&
    Date.parse(creds.expiresAt) < Date.now() + REFRESH_MARGIN_MS;
  if (!deps.refresh || !expiringSoon) return creds;
  try {
    const fresh = await deps.refresh(creds);
    if (fresh) {
      await deps.vault.save(deps.account, fresh);
      return fresh;
    }
  } catch (err) {
    // An auth-coded refresh failure (revoked grant) must PROPAGATE:
    // returning the stale token would just move the failure to the next API
    // call as an untyped 401 retry-storm. Swallow-and-warn stays correct
    // only for transient failures (network, 5xx), where the stale token may
    // in fact still work.
    if (sourceErrorCode(err) === 'auth') throw err;
    deps.warn(`token refresh failed: ${String(err)}`);
  }
  return creds;
}
