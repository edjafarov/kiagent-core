import type { Credentials, Source } from '@shared/contracts';

import type { ConnectBroker } from '../auth/connect-broker';
import type { Converter } from '../core/converter/converter';
import { gmailSource, googleOAuthProfile, googleRefresher } from './gmail';
import { createImapSource } from './imap';
import { createLocalFolderSource } from './local-folder';
import { createSharedFolderSource, type SharedFolderHost } from './shared-folder';

/** The folders `local-folder` leaves to the `shared-folder` source: none until
 *  this device shares folders. */
export function sharedSubtrees(host: SharedFolderHost | null | undefined): string[] {
  if (!host?.sharedFolders.enabled()) return [];
  const roots = host.sharedFolders.roots();
  return [roots.incoming, roots.sorted].filter((r): r is string => !!r);
}

/**
 * First-party sources. Each family registers its source; OAuth-backed
 * families also register their profile with the connect broker and their
 * refresher with the engine (via the returned map entries).
 *
 * Not yet ported (see docs/rebuild/LEFTOVERS.md): google-docs, ms365,
 * onedrive, browser; WhatsApp waits on the extension runtime.
 */
export function registerBundledSources(
  register: (source: Source) => void,
  broker: ConnectBroker,
  converter: Pick<Converter, 'expandPage'>,
  scratchDir?: string,
  /** The shared-folders service and database, once the host has built them. */
  sharedHost?: () => SharedFolderHost | null,
): Map<string, (creds: Credentials) => Promise<Credentials | null>> {
  register(
    createLocalFolderSource({
      converter,
      scratchDir,
      // The shared folders belong to the `shared-folder` source.
      excluded: () => sharedSubtrees(sharedHost?.()),
    }),
  );
  register(createSharedFolderSource(sharedHost ?? (() => null)));
  register(createImapSource());
  register(gmailSource);
  broker.registerOAuthProfile('gmail', googleOAuthProfile);
  return new Map([['gmail', googleRefresher]]);
}
