/** The installable-provider dispatch map behind inference:install/cancel.
 *  Cancel is deliberately GLOBAL: the autoInstall consent is one shared pref,
 *  so a cancel that revoked consent but aborted only one provider's download
 *  would leave the other's in-flight download running under a consent that no
 *  longer exists (spec §5). One opt-in, one revocation. */
export interface InstallableProvider {
  ensureInstalled(): void;
  cancelInstall(): Promise<void>;
}

export function createInstallRegistry(
  entries: Record<string, InstallableProvider>,
) {
  return {
    installable: (id: string): boolean => id in entries,
    install(id: string): void {
      entries[id]?.ensureInstalled(); // unknown id: no-op
    },
    async cancelAll(): Promise<void> {
      await Promise.all(Object.values(entries).map((e) => e.cancelInstall()));
    },
  };
}
