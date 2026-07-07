import { buildExternalId, stripAngle } from '../ids';

describe('stripAngle', () => {
  it('removes surrounding angle brackets and trims', () => {
    expect(stripAngle('  <abc123@mail.example.com>  ')).toBe('abc123@mail.example.com');
  });

  it('leaves a bare id untouched (trimmed)', () => {
    expect(stripAngle(' abc123 ')).toBe('abc123');
  });

  it('does not strip a lone leading or trailing bracket', () => {
    expect(stripAngle('<abc123')).toBe('<abc123');
    expect(stripAngle('abc123>')).toBe('abc123>');
  });
});

describe('buildExternalId', () => {
  it('joins mailbox, uidValidity and uid with colons', () => {
    expect(buildExternalId('INBOX', '12345', 99)).toBe('INBOX:12345:99');
  });

  it('folds UIDVALIDITY in so a rollover cannot alias a stale id', () => {
    const before = buildExternalId('INBOX', '1', 99);
    const after = buildExternalId('INBOX', '2', 99);
    expect(before).not.toBe(after);
  });
});
