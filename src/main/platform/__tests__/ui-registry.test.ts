/** @jest-environment node */
import { createUiRegistry } from '../ui-registry';

describe('createUiRegistry', () => {
  it('resolve() is undefined for a name nobody registered', () => {
    const registry = createUiRegistry();
    expect(registry.resolve('test.ext', 'foo')).toBeUndefined();
    expect(registry.namesFor('test.ext')).toEqual([]);
  });

  it('handle() registers and resolve() reports the incarnation + tier', () => {
    const registry = createUiRegistry();
    const inc = registry.bind('test.ext', 'inc-1', 'bundled');
    inc.handle('foo');
    expect(registry.resolve('test.ext', 'foo')).toEqual({
      incarnation: 'inc-1',
      tier: 'bundled',
    });
    expect(registry.namesFor('test.ext')).toEqual(['foo']);
  });

  it('duplicate names REJECT — same incarnation registering twice', () => {
    const registry = createUiRegistry();
    const inc = registry.bind('test.ext', 'inc-1', 'external');
    inc.handle('foo');
    expect(() => inc.handle('foo')).toThrow(/already registered/);
    // The registry entry is untouched by the rejected second call.
    expect(registry.namesFor('test.ext')).toEqual(['foo']);
  });

  it('duplicate names REJECT — a DIFFERENT (later) incarnation racing for the same name', () => {
    const registry = createUiRegistry();
    const a = registry.bind('test.ext', 'inc-a', 'external');
    const b = registry.bind('test.ext', 'inc-b', 'external');
    a.handle('foo');
    expect(() => b.handle('foo')).toThrow(/already registered/);
    expect(registry.resolve('test.ext', 'foo')).toEqual({
      incarnation: 'inc-a',
      tier: 'external',
    });
  });

  it('unhandle() is local-owner-only: a stale/other incarnation cannot rip out a live registration', () => {
    const registry = createUiRegistry();
    const a = registry.bind('test.ext', 'inc-a', 'external');
    const b = registry.bind('test.ext', 'inc-b', 'external');
    a.handle('foo');
    // b never owned 'foo' — its unhandle must be a no-op.
    b.unhandle('foo');
    expect(registry.resolve('test.ext', 'foo')).toEqual({
      incarnation: 'inc-a',
      tier: 'external',
    });
    a.unhandle('foo');
    expect(registry.resolve('test.ext', 'foo')).toBeUndefined();
  });

  it('unhandle() on an unknown name never throws', () => {
    const registry = createUiRegistry();
    const inc = registry.bind('test.ext', 'inc-1', 'external');
    expect(() => inc.unhandle('nope')).not.toThrow();
  });

  describe('close() — incarnation teardown', () => {
    it('synchronously drops every name this incarnation owns', () => {
      const registry = createUiRegistry();
      const inc = registry.bind('test.ext', 'inc-1', 'external');
      inc.handle('foo');
      inc.handle('bar');
      inc.close();
      expect(registry.namesFor('test.ext')).toEqual([]);
      expect(registry.resolve('test.ext', 'foo')).toBeUndefined();
      expect(registry.resolve('test.ext', 'bar')).toBeUndefined();
    });

    it("never touches a DIFFERENT incarnation's registrations", () => {
      const registry = createUiRegistry();
      const a = registry.bind('test.ext', 'inc-a', 'external');
      const b = registry.bind('test.ext', 'inc-b', 'external');
      a.handle('foo');
      b.handle('bar');
      a.close();
      expect(registry.namesFor('test.ext')).toEqual(['bar']);
    });

    it('is idempotent', () => {
      const registry = createUiRegistry();
      const inc = registry.bind('test.ext', 'inc-1', 'external');
      inc.handle('foo');
      inc.close();
      expect(() => inc.close()).not.toThrow();
      expect(registry.namesFor('test.ext')).toEqual([]);
    });

    it('a STALE incarnation calling into a live successor is rejected — closed incarnation cannot register', () => {
      const registry = createUiRegistry();
      const a = registry.bind('test.ext', 'inc-a', 'external');
      a.handle('foo');
      a.close(); // simulates teardown having already fired for A
      const b = registry.bind('test.ext', 'inc-b', 'external');
      b.handle('foo'); // the live successor re-registers cleanly
      expect(registry.namesFor('test.ext')).toEqual(['foo']);
      expect(registry.resolve('test.ext', 'foo')).toEqual({
        incarnation: 'inc-b',
        tier: 'external',
      });
      // A's own handle is unusable post-close, even for a NEW name — this
      // is the case that matters: an in-flight RPC call from A that only
      // reaches the registry AFTER teardown started must not silently
      // succeed and land in what is now B's live state.
      expect(() => a.handle('freshly-different-name')).toThrow(
        /already been torn down/,
      );
    });

    it('a stale incarnation cannot broadcast into a live successor either', () => {
      const registry = createUiRegistry();
      const a = registry.bind('test.ext', 'inc-a', 'external');
      a.close();
      expect(() => a.broadcast('evt', { x: 1 })).toThrow(
        /already been torn down/,
      );
    });
  });

  describe('broadcast()', () => {
    it('fans out to every onBroadcast subscriber with extensionId/name/payload', () => {
      const registry = createUiRegistry();
      const inc = registry.bind('test.ext', 'inc-1', 'external');
      const seen: unknown[] = [];
      const off1 = registry.onBroadcast((evt) => seen.push(evt));
      const off2 = registry.onBroadcast((evt) => seen.push(evt));
      inc.broadcast('evt', { x: 1 });
      expect(seen).toEqual([
        { extensionId: 'test.ext', name: 'evt', payload: { x: 1 } },
        { extensionId: 'test.ext', name: 'evt', payload: { x: 1 } },
      ]);
      off1();
      off2();
    });

    it('does not require a prior handle() for the broadcast name', () => {
      const registry = createUiRegistry();
      const inc = registry.bind('test.ext', 'inc-1', 'external');
      expect(() => inc.broadcast('never-handled', 1)).not.toThrow();
    });

    it('unsubscribing stops further delivery', () => {
      const registry = createUiRegistry();
      const inc = registry.bind('test.ext', 'inc-1', 'external');
      const seen: unknown[] = [];
      const off = registry.onBroadcast((evt) => seen.push(evt));
      off();
      inc.broadcast('evt', 1);
      expect(seen).toEqual([]);
    });
  });
});
