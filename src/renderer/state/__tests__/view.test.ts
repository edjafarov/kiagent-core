import {
  KNOWN_VIEWS,
  isExtView,
  isKnownView,
  makeExtView,
  nextResolved,
  parseExtView,
  type ResolvedView,
} from '../view';

describe('nextResolved', () => {
  test('first navigation starts at epoch 1 and pushes nothing', () => {
    expect(nextResolved(null, 'sources')).toEqual({
      next: { view: 'sources', params: undefined, epoch: 1 },
      push: false,
    });
  });

  test('cross-view navigation bumps epoch and pushes history', () => {
    const prev: ResolvedView = { view: 'sources', epoch: 3 };
    expect(nextResolved(prev, 'marketplace')).toEqual({
      next: { view: 'marketplace', params: undefined, epoch: 4 },
      push: true,
    });
  });

  test('same-view re-navigation bumps epoch but does NOT push history', () => {
    const prev: ResolvedView = { view: 'sources', epoch: 3 };
    const { next, push } = nextResolved(prev, 'sources');
    expect(next.epoch).toBe(4); // key change → screen remounts → add panel resets
    expect(push).toBe(false); // no duplicate back stop
  });

  test('params ride along', () => {
    const { next } = nextResolved(null, 'connection', { anchor: 'mcp' });
    expect(next.params).toEqual({ anchor: 'mcp' });
  });
});

// B3: the view catalog and the contributed-view encoding (item 1).
describe('isKnownView / KNOWN_VIEWS', () => {
  test('the five core routes are known, and nothing else is', () => {
    expect(KNOWN_VIEWS).toEqual([
      'sources',
      'connection',
      'logs',
      'outbox',
      'marketplace',
    ]);
    for (const v of KNOWN_VIEWS) expect(isKnownView(v)).toBe(true);
    expect(isKnownView('expenses')).toBe(false);
    expect(isKnownView('ext:test.basic/main')).toBe(false);
  });
});

describe('makeExtView / parseExtView (contributed view encoding)', () => {
  test('round-trips a valid pair', () => {
    const v = makeExtView('test.basic', 'main');
    expect(v).toBe('ext:test.basic/main');
    expect(parseExtView(v)).toEqual({
      extensionId: 'test.basic',
      contributionId: 'main',
    });
    expect(isExtView(v)).toBe(true);
  });

  test('rejects malformed strings', () => {
    for (const bad of [
      '',
      'ext:',
      'ext:onlyid',
      'sources',
      'ext:test.basic/',
      'ext:/main',
      'ext:BAD.basic/main', // uppercase not allowed in extension id
      'ext:test.basic/MAIN', // uppercase not allowed in contribution id
      'ext:test.basic/-main', // contribution id must start alnum
      'ext:test/main', // extension id must have a publisher.name dot
    ]) {
      expect(parseExtView(bad)).toBeNull();
      expect(isExtView(bad)).toBe(false);
    }
  });

  test('cannot collide with a KnownView', () => {
    for (const v of KNOWN_VIEWS) {
      expect(isExtView(v)).toBe(false);
      expect(parseExtView(v)).toBeNull();
    }
  });

  test('makeExtView throws on an id outside either charset', () => {
    expect(() => makeExtView('bad id', 'main')).toThrow();
    expect(() => makeExtView('test.basic', 'bad id')).toThrow();
    expect(() => makeExtView('test.basic', '')).toThrow();
    // Embedding the separator is exactly the forgery attempt this
    // encoding must refuse to compose in the first place.
    expect(() => makeExtView('test.basic/evil', 'main')).toThrow();
    expect(() => makeExtView('test.basic', 'main/evil')).toThrow();
  });

  test('an id containing the separator cannot forge a different pair', () => {
    // If makeExtView refuses to compose these (asserted above), the only
    // remaining attack is a hand-crafted string smuggling an extra '/'.
    // The parser must reject it outright rather than resolve it to EITHER
    // of the two candidate decompositions.
    const crafted = 'ext:test.basic/evil/main';
    expect(parseExtView(crafted)).toBeNull();
    // Neither candidate decomposition is what a forger gets back.
    expect(parseExtView(crafted)).not.toEqual({
      extensionId: 'test.basic/evil',
      contributionId: 'main',
    });
    expect(parseExtView(crafted)).not.toEqual({
      extensionId: 'test.basic',
      contributionId: 'evil/main',
    });
  });

  test('two distinct valid pairs never encode to the same string', () => {
    const a = makeExtView('test.basic', 'main');
    const b = makeExtView('test.other', 'main');
    const c = makeExtView('test.basic', 'other');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
