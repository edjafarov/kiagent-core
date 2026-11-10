/** Which `local-folder` accounts the one-time migration may touch: this
 *  device's own. The accounts table is copied to every device, so another
 *  Mac's account (often with the very same absolute paths) is in it too, and
 *  archiving its documents would be archiving somebody else's index. */
import type { ExternalRef } from '@shared/contracts';

import type { LocalFolderAccess } from './migrate';

export interface LocalFolderHost {
  /** Every account in the table, other devices' included. */
  accounts(): Promise<{ id: string; source: string; ownerDeviceId?: string | null; config?: unknown }[]>;
  /** This device's id; null while it has none. */
  deviceId(): string | null;
  /** The folders an account tracks (absolute). Throws on a malformed config. */
  roots(account: { id: string; config?: unknown }): string[];
  archive(accountId: string, refs: ExternalRef[]): Promise<void>;
}

/** An account with no owner is this device's (a device that has not joined
 *  owns all its local accounts); one with an owner is this device's only when
 *  the owner is this device. */
export function ownLocalFolders(h: LocalFolderHost): LocalFolderAccess {
  return {
    accounts: async () => {
      const me = h.deviceId();
      return (await h.accounts())
        .filter((a) => a.source === 'local-folder' && (a.ownerDeviceId == null || a.ownerDeviceId === me))
        .flatMap((a) => {
          try {
            return [{ id: a.id, roots: h.roots(a) }];
          } catch {
            return []; // a malformed config must not hide the others
          }
        });
    },
    archive: h.archive,
  };
}
