import { parseOperators } from '../tools/search-operators';

describe('parseOperators', () => {
  it('extracts people operators and leaves the rest as FTS text', () => {
    const p = parseOperators('from:rkaplun@zoolatech.com kiagent log*');
    expect(p.from).toEqual(['rkaplun@zoolatech.com']);
    expect(p.text).toBe('kiagent log*');
  });

  it('supports quoted values with spaces', () => {
    const p = parseOperators('from:"Roman Kaplun" logs');
    expect(p.from).toEqual(['Roman Kaplun']);
    expect(p.text).toBe('logs');
  });

  it('ORs within an operator by repetition', () => {
    const p = parseOperators('from:a@x.com from:b@y.com');
    expect(p.from).toEqual(['a@x.com', 'b@y.com']);
    expect(p.text).toBe('');
  });

  it('parses the full operator set', () => {
    const p = parseOperators(
      'to:me@x.com participant:sebastian label:inbox has:attachment filename:report ext:.PDF in:gmail type:email.thread order:newest tunnel',
    );
    expect(p.to).toEqual(['me@x.com']);
    expect(p.participant).toEqual(['sebastian']);
    expect(p.label).toEqual(['inbox']);
    expect(p.hasAttachment).toBe(true);
    expect(p.filename).toEqual(['report']);
    expect(p.ext).toEqual(['pdf']); // dot stripped, lowercased
    expect(p.source).toBe('gmail');
    expect(p.type).toBe('email.thread');
    expect(p.order).toBe('newest');
    expect(p.text).toBe('tunnel');
  });

  it('treats source: as an alias of in:', () => {
    expect(parseOperators('source:slack hi').source).toBe('slack');
  });

  it('leaves unknown operators, empty values, and non-attachment has: as literal text', () => {
    const p = parseOperators(
      'foo:bar from: has:invite order:sideways deadline',
    );
    expect(p.from).toEqual([]);
    expect(p.hasAttachment).toBe(false);
    expect(p.order).toBeUndefined();
    expect(p.text).toBe('foo:bar from: has:invite order:sideways deadline');
  });

  it('leaves negated or grouped operator-lookalikes as literal text', () => {
    const p = parseOperators('-from:x@y.com (from:a@b.com OR spam)');
    expect(p.from).toEqual([]);
    expect(p.text).toBe('-from:x@y.com (from:a@b.com OR spam)');
  });

  it('is case-insensitive on operator names', () => {
    expect(parseOperators('FROM:x@y.com').from).toEqual(['x@y.com']);
  });

  it('preserves ordinary quoted phrases untouched', () => {
    const p = parseOperators('"term sheet" from:vc@fund.com');
    expect(p.text).toBe('"term sheet"');
    expect(p.from).toEqual(['vc@fund.com']);
  });
});
