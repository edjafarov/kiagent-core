/** @jest-environment node */
import type { ExtInvokeEnvelope } from '@shared/ipc';

import { createExtInvokeHandler } from '../ext-invoke';

function makePlatform(callUi: (...args: unknown[]) => unknown) {
  return { callUi: callUi as never };
}

describe('createExtInvokeHandler — the ext:invoke dispatch boundary', () => {
  it('NEVER rejects: resolves a success envelope on the happy path', async () => {
    const callUi = jest.fn(async () => ({ ok: true, value: 42 }));
    const handler = createExtInvokeHandler({
      isTrustedSender: () => true,
      platform: makePlatform(callUi),
    });
    const result = await handler(
      { sender: {} },
      { extensionId: 'test.ext', name: 'foo', payload: { a: 1 } },
    );
    expect(result).toEqual({ ok: true, value: 42 });
    expect(callUi).toHaveBeenCalledWith('test.ext', 'foo', { a: 1 });
  });

  it('untrusted sender resolves EXT_UNTRUSTED_SENDER — never throws, never calls platform', async () => {
    const callUi = jest.fn();
    const handler = createExtInvokeHandler({
      isTrustedSender: () => false,
      platform: makePlatform(callUi),
    });
    const result = await handler(
      { sender: {} },
      { extensionId: 'test.ext', name: 'foo', payload: null },
    );
    expect(result).toEqual({
      ok: false,
      code: 'EXT_UNTRUSTED_SENDER',
      message: 'untrusted renderer',
    });
    expect(callUi).not.toHaveBeenCalled();
  });

  describe('malformed requests resolve EXT_MALFORMED_REQUEST — never called into platform.callUi', () => {
    const cases: Array<[string, unknown]> = [
      ['not an object', 'nope'],
      ['null', null],
      ['missing extensionId', { name: 'foo' }],
      ['non-string extensionId', { extensionId: 1, name: 'foo' }],
      ['empty extensionId', { extensionId: '', name: 'foo' }],
      ['missing name', { extensionId: 'test.ext' }],
      ['non-string name', { extensionId: 'test.ext', name: 9 }],
      ['empty name', { extensionId: 'test.ext', name: '' }],
    ];
    it.each(cases)('%s', async (_label, req) => {
      const callUi = jest.fn();
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform: makePlatform(callUi),
      });
      const result = (await handler({ sender: {} }, req)) as ExtInvokeEnvelope;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('EXT_MALFORMED_REQUEST');
      expect(callUi).not.toHaveBeenCalled();
    });
  });

  it('passes payload through unvalidated — payload is between the renderer and the handler, not the host', async () => {
    const callUi = jest.fn(async () => ({ ok: true, value: null }));
    const handler = createExtInvokeHandler({
      isTrustedSender: () => true,
      platform: makePlatform(callUi),
    });
    await handler(
      { sender: {} },
      { extensionId: 'test.ext', name: 'foo', payload: undefined },
    );
    expect(callUi).toHaveBeenCalledWith('test.ext', 'foo', undefined);
  });

  it('relays an unknown-destination envelope from platform.callUi verbatim', async () => {
    const callUi = jest.fn(async () => ({
      ok: false,
      code: 'EXT_UNKNOWN_DESTINATION',
      message: "extension 'test.ext' has no ui handler 'foo'",
    }));
    const handler = createExtInvokeHandler({
      isTrustedSender: () => true,
      platform: makePlatform(callUi),
    });
    const result = await handler(
      { sender: {} },
      { extensionId: 'test.ext', name: 'foo', payload: null },
    );
    expect(result).toEqual({
      ok: false,
      code: 'EXT_UNKNOWN_DESTINATION',
      message: "extension 'test.ext' has no ui handler 'foo'",
    });
  });

  it('a platform.callUi that violates its own never-reject contract still resolves an envelope (belt-and-suspenders)', async () => {
    const callUi = jest.fn(async () => {
      throw new Error('platform contract violation');
    });
    const handler = createExtInvokeHandler({
      isTrustedSender: () => true,
      platform: makePlatform(callUi),
    });
    const result = await handler(
      { sender: {} },
      { extensionId: 'test.ext', name: 'foo', payload: null },
    );
    expect(result).toEqual({
      ok: false,
      code: 'EXT_HANDLER_FAILED',
      message: 'platform contract violation',
    });
  });

  describe('an unclonable ui-handler result — C1: this must never hang the renderer', () => {
    it('a live function in the resolved value resolves EXT_HANDLER_FAILED, never the raw envelope', async () => {
      const callUi = jest.fn(async () => ({
        ok: true,
        value: { f: () => 'nope' },
      }));
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform: makePlatform(callUi),
      });
      const result = await handler(
        { sender: {} },
        { extensionId: 'test.ext', name: 'foo', payload: null },
      );
      expect(result).toEqual({
        ok: false,
        code: 'EXT_HANDLER_FAILED',
        message: expect.stringContaining('not structured-clone-safe'),
      });
      // The final returned value must ITSELF always be clone-safe — an
      // error envelope that failed to clone would be exactly the same
      // hang this guard exists to prevent.
      expect(() => structuredClone(result)).not.toThrow();
    });

    it('an unresolved Promise in the resolved value also resolves EXT_HANDLER_FAILED', async () => {
      const callUi = jest.fn(async () => ({
        ok: true,
        value: { p: Promise.resolve(1) },
      }));
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform: makePlatform(callUi),
      });
      const result = await handler(
        { sender: {} },
        { extensionId: 'test.ext', name: 'foo', payload: null },
      );
      expect(result).toEqual({
        ok: false,
        code: 'EXT_HANDLER_FAILED',
        message: expect.stringContaining('not structured-clone-safe'),
      });
      expect(() => structuredClone(result)).not.toThrow();
    });

    it('a clone-safe success envelope still passes through unchanged', async () => {
      const callUi = jest.fn(async () => ({
        ok: true,
        value: { echoed: { a: [1, 2, 3] } },
      }));
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform: makePlatform(callUi),
      });
      const result = await handler(
        { sender: {} },
        { extensionId: 'test.ext', name: 'foo', payload: null },
      );
      expect(result).toEqual({ ok: true, value: { echoed: { a: [1, 2, 3] } } });
    });
  });

  it('a synchronously-throwing isTrustedSender still resolves an envelope, never rejects the returned promise', async () => {
    const handler = createExtInvokeHandler({
      isTrustedSender: () => {
        throw new Error('sender check exploded');
      },
      platform: makePlatform(jest.fn()),
    });
    await expect(
      handler({ sender: {} }, { extensionId: 'a', name: 'b', payload: null }),
    ).resolves.toEqual({
      ok: false,
      code: 'EXT_HANDLER_FAILED',
      message: 'sender check exploded',
    });
  });
});
