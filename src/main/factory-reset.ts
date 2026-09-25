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

export async function runFactoryReset(
  deps: FactoryResetDeps,
): Promise<FactoryResetOutcome> {
  await deps.pauseSources();
  let coreWiped = false;
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
  if (coreWiped) {
    try {
      await deps.afterCoreWipe();
    } catch (err) {
      error ??= message(err);
    }
  }
  return {
    ok: coreWiped && failed.length === 0 && error === null,
    coreWiped,
    failed,
    error,
  };
}
