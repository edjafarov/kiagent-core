/**
 * Source-id → Sender map for the send pipeline. Bundled transports register
 * here; extension senders (manifest `send` cap) join in a later phase via the
 * platform. A source with no entry cannot even hold a draft — the service
 * gates draft creation on sender availability.
 */
import type { Sender } from '@shared/contracts';

import type { CoreStore } from '../../core/store/store';
import { createSmtpSender } from './smtp';

export function buildBundledSenders(deps: {
  store: CoreStore;
}): Map<string, Sender> {
  return new Map<string, Sender>([
    ['imap', createSmtpSender({ store: deps.store })],
  ]);
}
