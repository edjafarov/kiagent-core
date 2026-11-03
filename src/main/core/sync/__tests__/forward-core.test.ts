import {
  FORWARDED_CHANNELS,
  forwardCore,
  isForwardedChannel,
  NO_MASTER_MESSAGE,
  SyncNoMaster,
  wrapForwardedChannels,
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
    'prefs:patch',
    'extension:set-enabled',
    'extension:install',
    'extension:uninstall',
  ])
    expect(isForwardedChannel(c)).toBe(true);
  for (const c of ['attention:list', 'outbox:list', 'calendar-out:list', 'accounts:list'])
    expect(isForwardedChannel(c)).toBe(false);
  expect(FORWARDED_CHANNELS).toHaveLength(15);
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
  expect(NO_MASTER_MESSAGE).toBe("Can't save this yet. No other device is reachable; try again in a minute.");
  expect(err.code).toBe('EXT_SYNC_NO_MASTER');
  const refused = { forward: async () => ({ ok: false as const, code: 'handler' as const, message: 'already sent' }) };
  await expect(forwardCore(refused, 'outbox:send', {})).rejects.toThrow('already sent');
});

it('a missing leader is also told to the UI once, through onNoMaster; a refusal is not', async () => {
  const seen: string[] = [];
  const none = { forward: async () => ({ ok: false as const, code: 'no-master' as const, message: 'x' }) };
  await forwardCore(none, 'outbox:send', {}, (m) => seen.push(m)).catch(() => undefined);
  expect(seen).toEqual([NO_MASTER_MESSAGE]);
  const refused = { forward: async () => ({ ok: false as const, code: 'handler' as const, message: 'already sent' }) };
  await forwardCore(refused, 'outbox:send', {}, (m) => seen.push(m)).catch(() => undefined);
  expect(seen).toEqual([NO_MASTER_MESSAGE]);
});

it('prefs:patch is a forwarded verb the leader can run, but a follower does not forward it whole', async () => {
  const handler = jest.fn(async () => 'ran');
  const send = jest.fn(async () => 'x');
  const table: Record<string, (r: unknown) => unknown> = { 'prefs:patch': handler, 'outbox:send': send };
  const forward = jest.fn(async () => ({ ok: true as const, value: 'leader' }));
  const local = wrapForwardedChannels(table, { forward, readOnly: () => true });
  expect(local.get('prefs:patch')).toBe(handler);
  expect(table['prefs:patch']).toBe(handler); // the handler splits and forwards its own user part
  await expect(table['outbox:send']({})).resolves.toBe('leader');
  expect(forward).toHaveBeenCalledTimes(1);
});
