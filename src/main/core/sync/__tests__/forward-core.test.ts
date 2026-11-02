import {
  FORWARDED_CHANNELS,
  forwardCore,
  isForwardedChannel,
  NO_MASTER_MESSAGE,
  SyncNoMaster,
} from '../forward-core';

it('the writing channels are forwarded, reads are not', () => {
  for (const c of [
    'attention:act',
    'outbox:send',
    'outbox:schedule',
    'outbox:discard',
    'outbox:redraft',
    'outbox:reopen',
    'calendar-out:confirm',
    'calendar-out:retry',
    'calendar-out:discard',
    'calendar-out:restore',
  ])
    expect(isForwardedChannel(c)).toBe(true);
  for (const c of ['attention:list', 'outbox:list', 'calendar-out:list', 'accounts:list'])
    expect(isForwardedChannel(c)).toBe(false);
  expect(FORWARDED_CHANNELS).toHaveLength(10);
});

it('forwardCore sends kind core with the channel name and returns the leader value', async () => {
  const forward = jest.fn(async () => ({ ok: true as const, value: { sent: true } }));
  await expect(forwardCore({ forward }, 'outbox:send', { draftId: 'd1' })).resolves.toEqual({ sent: true });
  expect(forward).toHaveBeenCalledWith({ kind: 'core', name: 'outbox:send', payload: { draftId: 'd1' } });
});

it('no leader rejects with the exact copy and a code; a refusal carries the leader message', async () => {
  const none = { forward: async () => ({ ok: false as const, code: 'no-master' as const, message: 'x' }) };
  const err = (await forwardCore(none, "attention:act", {}).catch((e: unknown) => e)) as SyncNoMaster;
  expect(err).toBeInstanceOf(SyncNoMaster);
  expect(err.message).toBe(NO_MASTER_MESSAGE);
  expect(err.code).toBe('EXT_SYNC_NO_MASTER');
  const refused = { forward: async () => ({ ok: false as const, code: 'handler' as const, message: 'already sent' }) };
  await expect(forwardCore(refused, 'outbox:send', {})).rejects.toThrow('already sent');
});
