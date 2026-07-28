/**
 * Source-id → Sender map for the send pipeline. Bundled transports register
 * here; extension senders (manifest `send` cap) join through `composeSenders`
 * below. A source with no entry cannot even hold a draft — the service gates
 * draft creation on sender availability.
 */
import type { Sender } from '@shared/contracts';

import type { LogSink } from '../../core/engine/engine';
import type { CoreStore } from '../../core/store/store';
import { createGmailSender } from './gmail';
import { createSmtpSender } from './smtp';

/** The read-only view the send pipeline actually needs. The service depends
 *  on THIS rather than on a Map so bundled transports and the extension
 *  sender registry can be composed behind one shape — the service never
 *  learns which side a Sender came from. */
export interface SenderLookup {
  get(sourceId: string): Sender | undefined;
  ids(): string[];
}

/** Bundled senders SHADOW extension senders on a colliding source id: an
 *  installed extension can never intercept sending for 'gmail'/'imap'.
 *  Both sides are read on every call (never snapshotted), so an extension
 *  that registers its sender after this composition is still picked up;
 *  `ids()` dedupes so the service's `supported: …` enumeration cannot list
 *  the same source twice. */
export function composeSenders(
  bundled: Map<string, Sender>,
  ext: { get(id: string): Sender | undefined; ids(): string[] },
): SenderLookup {
  return {
    get: (id) => bundled.get(id) ?? ext.get(id),
    ids: () => [...new Set([...bundled.keys(), ...ext.ids()])],
  };
}

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
    ['gmail', createGmailSender({ store: deps.store })],
  ]);
}
