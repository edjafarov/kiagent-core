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
 * extension's namespace is retried from its recovery marker. Until it is
 * finished, a journal says so (reset-journal.ts): a reset that failed, or
 * that the app quit or crashed in, is offered again at the next start,
 * before any extension runs on the half-deleted data.
 */
import type { FactoryResetOutcome } from '@shared/ipc';

import type { CoreStore } from './core/store/store';
import type { ResetAllResult } from './platform/extension-platform';
import type { ResetJournal } from './reset-journal';

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
  journal: Pick<ResetJournal, 'begin' | 'end'>;
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
  // Before anything is paused or deleted. Throws when it cannot be written,
  // and then nothing has happened.
  deps.journal.begin();
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
      // Finished: every extension namespace was reset (the core wipe runs
      // only after all of them) and nothing describes the old data. An
      // extension that did not start again has its own recovery marker.
      deps.journal.end();
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

export interface InterruptedResetDeps {
  journal: Pick<ResetJournal, 'pending' | 'end'>;
  /** Asks the user; true finishes the reset, false keeps what is left. */
  confirmFinish(): Promise<boolean>;
  /** Finds the extensions without activating any. A rejection means the
   *  reset is not run. */
  loadExtensions(): Promise<void>;
  /** Activates them (loading first if needed); already active ones stay. */
  startExtensions(): Promise<void>;
  /** The same reset "Reset all" runs. */
  reset(): Promise<FactoryResetOutcome>;
}

/**
 * Boot: start extensions — but first, when the last Reset all never
 * finished, let the user decide, because some data is deleted and some is
 * not. Finish: the reset runs with the extensions loaded and none active,
 * so none runs on the half-deleted data. Keep: the record is dropped and
 * boot goes on as usual. Nothing is deleted without that answer. Resolves
 * with the finished reset's outcome, or null.
 */
export async function startAfterInterruptedReset(
  deps: InterruptedResetDeps,
): Promise<FactoryResetOutcome | null> {
  let outcome: FactoryResetOutcome | null = null;
  if (deps.journal.pending()) {
    if (await deps.confirmFinish()) {
      // Not finding the extensions stops the finish before it starts: the
      // reset would otherwise wipe core, skip every extension's data, and
      // drop the record. The record stays, so the question comes back.
      outcome = await deps
        .loadExtensions()
        .then(() => deps.reset())
        .catch(
          (err): FactoryResetOutcome => ({
            ok: false,
            coreWiped: false,
            failed: [],
            error: message(err),
          }),
        );
    } else {
      try {
        deps.journal.end();
      } catch {
        // Then the question comes back at the next start.
      }
    }
  }
  await deps.startExtensions();
  return outcome;
}
