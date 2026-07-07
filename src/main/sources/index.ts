import type { Credentials, Source } from '@shared/contracts';

import type { ConnectBroker } from '../auth/connect-broker';
import { gmailSource, googleOAuthProfile, googleRefresher } from './gmail';
import { createImapSource } from './imap';
import { localFolderSource } from './local-folder';

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
): Map<string, (creds: Credentials) => Promise<Credentials | null>> {
  register(localFolderSource);
  register(createImapSource());
  register(gmailSource);
  broker.registerOAuthProfile('gmail', googleOAuthProfile);
  return new Map([['gmail', googleRefresher]]);
}
