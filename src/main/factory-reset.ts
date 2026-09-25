/**
 * Factory reset — "Reset all" on Settings → Storage (alpha-cent#192).
 *
 * The order is fixed by ExtensionPlatform.resetAll: every extension's data
 * namespace first, one at a time, stopping at the first that fails; then the
 * main index, accounts and credentials in ONE transaction; then VACUUM and the
 * extension restarts. Only the middle step is the point of no return, so the
 * outcome is keyed on it: the store announces that its deletion committed
 * (`onReset`), and that — not a rejection, not `ok: false` — decides whether
 * the app state describing the old data (identity, accounts, onboarding
 * latches, the MCP activity feed) is cleared, and what the user is told.
 *
 * The announcement can be lost: the DB worker commits the deletion and dies
 * before replying, and the reset rejects without it. So a reset that rejects
 * unannounced asks the store afterwards — the deletion is one transaction, so
 * accounts that were there before and are all gone mean it committed. When
 * that cannot be told (the store no longer answers, or there were no accounts
 * to go by), the outcome says so (`coreWiped: null`) instead of guessing, and
 * nothing is cleared.
 *
 * A reset that stops before the core wipe leaves the extensions it already
 * reset empty; nothing is restored. Running it again finishes it: the failed
 * extension's namespace is retried from its recovery marker.
 */
import type { FactoryResetOutcome } from '@shared/ipc';

import type { CoreStore } from './core/store/store';
import type { ResetAllResult } from './platform/extension-platform';

export interface FactoryResetDeps {
  store: Pick<CoreStore, 'onReset'> & {
    maintenance: Pick<CoreStore['maintenance'], 'resetAll'>;
    /** Only counted: were there accounts, and are they gone. */
    read: { accounts(): Promise<readonly unknown[]> };
  };
  /** Resets extension data, then the store; null before extensions boot. */
  platform: { resetAll(): Promise<ResetAllResult> } | null | undefined;
  /** Stops every sync loop so none commits against a deleted account. */
  pauseSources(): Promise<void>;
  /** Clears the app state that describes the wiped data. */
  afterCoreWipe(): Promise<void>;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** How many accounts the store holds; null when it does not answer. */
const accountCount = (
  store: FactoryResetDeps['store'],
): Promise<number | null> =>
  store.read.accounts().then(
    (accounts) => accounts.length,
    () => null,
  );

export async function runFactoryReset(
  deps: FactoryResetDeps,
): Promise<FactoryResetOutcome> {
  await deps.pauseSources();
  const accountsBefore = await accountCount(deps.store);
  let coreWiped: boolean | null = false;
  const offReset = deps.store.onReset(() => {
    coreWiped = true;
  });
  let failed: FactoryResetOutcome['failed'] = [];
  let error: string | null = null;
  try {
    if (deps.platform) {
      const result = await deps.platform.resetAll();
      failed = result.failed.map(({ pluginId, error: e }) => ({
        pluginId,
        error: e,
      }));
    } else {
      await deps.store.maintenance.resetAll();
    }
  } catch (err) {
    error = message(err);
  } finally {
    offReset();
  }
  if (!coreWiped && error !== null) {
    // One transaction: accounts that were there and are all gone mean it
    // committed. No accounts to go by, or no answer: unknown.
    const accountsAfter = await accountCount(deps.store);
    coreWiped =
      accountsBefore && accountsAfter !== null ? accountsAfter === 0 : null;
  }
  if (coreWiped === true) {
    try {
      await deps.afterCoreWipe();
    } catch (err) {
      error ??= message(err);
    }
  }
  return {
    ok: coreWiped === true && failed.length === 0 && error === null,
    coreWiped,
    failed,
    error,
  };
}
