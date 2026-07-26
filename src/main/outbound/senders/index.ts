/**
 * Source-id → Sender map for the send pipeline. Bundled transports register
 * here; extension senders (manifest `send` cap) join in a later phase via the
 * platform. A source with no entry cannot even hold a draft — the service
 * gates draft creation on sender availability.
 */
import type { Sender } from '@shared/contracts';

import type { LogSink } from '../../core/engine/engine';
import type { CoreStore } from '../../core/store/store';
import { createSmtpSender } from './smtp';

export function buildBundledSenders(deps: {
  store: CoreStore;
  logSink: LogSink;
}): Map<string, Sender> {
  return new Map<string, Sender>([
    [
      'imap',
      createSmtpSender({
        store: deps.store,
        // smtp.ts's own log call is already content-free (account id + error
        // text, never message bodies/subjects) — this just makes sure a
        // Sent-append failure actually reaches a durable log instead of the
        // default noop, so it's visible in production. Category matches
        // service.ts's use of the same LogSink for outbound events.
        log: (msg) => deps.logSink.log('outbound', 'error', msg),
      }),
    ],
  ]);
}
