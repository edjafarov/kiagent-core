import {
  validateAttentionActRequest,
  validateAttentionListRequest,
} from '../ipc-request';

describe('attention renderer request validation', () => {
  it('S10 rejects malformed list payloads with ATTENTION_INVALID_REQUEST', () => {
    for (const request of [{ kinds: 5 }, { kinds: 'upcoming' }]) {
      expect(() => validateAttentionListRequest(request)).toThrow(
        expect.objectContaining({ code: 'ATTENTION_INVALID_REQUEST' }),
      );
    }
  });

  it('S10 rejects missing or malformed act payloads with ATTENTION_INVALID_REQUEST', () => {
    for (const request of [undefined, { action: 'dismiss' }, { id: 'x' }]) {
      expect(() => validateAttentionActRequest(request)).toThrow(
        expect.objectContaining({ code: 'ATTENTION_INVALID_REQUEST' }),
      );
    }
  });

  it('S10 accepts only the literal attention wire shapes', () => {
    expect(validateAttentionListRequest(undefined)).toBeUndefined();
    expect(validateAttentionListRequest({ kinds: ['upcoming'] })).toEqual([
      'upcoming',
    ]);
    expect(validateAttentionActRequest({ id: 'x', action: 'dismiss' })).toEqual(
      { id: 'x', action: 'dismiss' },
    );
  });
});

it('S10b rejects a list kind outside the wire allow-list', () => {
  expect(() => validateAttentionListRequest({ kinds: ['bogus'] })).toThrow(
    expect.objectContaining({ code: 'ATTENTION_INVALID_REQUEST' }),
  );
});
