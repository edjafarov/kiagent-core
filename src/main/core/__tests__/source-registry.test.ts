import type { DocumentInput, Source } from '@shared/contracts';

import { createSourceRegistry } from '../boot';

/** The minimum a `Source` needs to be registrable. Nothing here is ever
 *  driven — the registry reads `descriptor` and `typeof reauthenticate` and
 *  nothing else — but every member is real, so the fixture type-checks
 *  against the interface instead of being cast through `as never`. */
function src(
  id: string,
  extra: Partial<Source<number, DocumentInput>> = {},
): Source<number, DocumentInput> {
  return {
    descriptor: { id, name: id, documentTypes: ['note'], auth: 'oauth' },
    async connect() {
      return { identifier: `${id}@example.com` };
    },
    async *pull() {
      yield { phase: 'live' as const, items: [], cursor: 0 };
    },
    toDocument: (item) => item,
    ...extra,
  };
}

const noopReauth = async (): Promise<void> => {};

describe('createSourceRegistry — hasReauthenticate is CORE-derived (C-9)', () => {
  it('is true for a source that implements reauthenticate, false for one that does not', () => {
    const sources = createSourceRegistry();
    sources.register(src('google-docs', { reauthenticate: noopReauth }));
    sources.register(src('imap'));

    // `as const` makes each entry a tuple, so `fromEntries` picks its
    // typed overload and `byId` is `{ [k: string]: SourceDescriptor }`
    // rather than `any`.
    const byId = Object.fromEntries(
      sources.list().map((d) => [d.id, d] as const),
    );
    expect(byId['google-docs'].hasReauthenticate).toBe(true);
    // THE regression this flag exists for (C-9). imap emits needsReauth on
    // every expired password and gains no reauthenticate in this train, so
    // Task 9 must read `false` here and fall back to today's
    // `accounts:add { sourceId }` route.
    expect(byId.imap.hasReauthenticate).toBe(false);
  });

  it('leaves every other descriptor field untouched', () => {
    const sources = createSourceRegistry();
    sources.register(
      src('onedrive', {
        descriptor: {
          id: 'onedrive',
          name: 'OneDrive',
          documentTypes: ['file'],
          auth: 'oauth',
          multiAccount: true,
          cadence: { every: '1h' },
          folderScope: true,
        },
        reauthenticate: noopReauth,
      }),
    );

    expect(sources.list()).toEqual([
      {
        id: 'onedrive',
        name: 'OneDrive',
        documentTypes: ['file'],
        auth: 'oauth',
        multiAccount: true,
        cadence: { every: '1h' },
        folderScope: true,
        hasReauthenticate: true,
      },
    ]);
  });

  it('OVERWRITES a connector-authored value — spread FIRST, then set; never `??`', () => {
    // `hasReauthenticate` is optional on SourceDescriptor, so a connector CAN
    // author it and a wrong value type-checks. Task 9 routes a destructive UI
    // decision off this flag, so core's answer must win in BOTH directions.
    // This test is what pins the spread ORDER: `{ hasReauthenticate: …,
    // ...s.descriptor }` fails on `liar`, and
    // `s.descriptor.hasReauthenticate ?? typeof s.reauthenticate === 'function'`
    // fails on both.
    const sources = createSourceRegistry();
    sources.register(
      src('liar', {
        descriptor: {
          id: 'liar',
          name: 'Liar',
          documentTypes: ['note'],
          auth: 'oauth',
          hasReauthenticate: true, // authored true; there is no method
        },
      }),
    );
    sources.register(
      src('modest', {
        descriptor: {
          id: 'modest',
          name: 'Modest',
          documentTypes: ['note'],
          auth: 'oauth',
          hasReauthenticate: false, // authored false; the method exists
        },
        reauthenticate: noopReauth,
      }),
    );

    const byId = Object.fromEntries(
      sources.list().map((d) => [d.id, d] as const),
    );
    expect(byId.liar.hasReauthenticate).toBe(false);
    expect(byId.modest.hasReauthenticate).toBe(true);
  });

  it('answers the same question for a PROXIED extension source', () => {
    // `source-proxy.makeSource` builds a base object and then attaches each
    // optional verb CONDITIONALLY behind its wire flag — `if
    // (entry.hasFetchBytes) { source.fetchBytes = … }`
    // (`source-proxy.ts:259-260`) — and Task 4 adds the `hasReauthenticate`
    // twin the same way. So `typeof s.reauthenticate === 'function'` is
    // exactly the right question for a proxied source too: an extension
    // without the verb has no property at all, not an always-present stub
    // that would make every extension look reconnectable.
    //
    // Built by hand here rather than through `source-proxy`, which needs a
    // live endpoint; Task 4 owns the round trip over the real RPC.
    const proxied = (
      hasReauthenticate: boolean,
    ): Source<number, DocumentInput> => {
      const s = src('ext.notion');
      if (hasReauthenticate) s.reauthenticate = noopReauth;
      return s;
    };

    const on = createSourceRegistry();
    on.register(proxied(true));
    expect(on.list()[0].hasReauthenticate).toBe(true);

    const off = createSourceRegistry();
    off.register(proxied(false));
    expect(off.list()[0].hasReauthenticate).toBe(false);
  });

  it('still registers, replaces on a colliding id, gets and unregisters', () => {
    // The lift out of bootCore() must be behaviour-identical: this is the
    // registry the whole app runs on, and `extension-platform.ts:338`
    // (`deps.sources.register(makeSource(s))`) writes into the same object.
    const sources = createSourceRegistry();
    const first = src('dup');
    const second = src('dup', { reauthenticate: noopReauth });

    sources.register(first);
    expect(sources.get('dup')).toBe(first);
    sources.register(second);
    expect(sources.get('dup')).toBe(second);
    expect(sources.list().map((d) => d.hasReauthenticate)).toEqual([true]);

    sources.unregister('dup');
    expect(sources.get('dup')).toBeUndefined();
    expect(sources.list()).toEqual([]);
  });
});
