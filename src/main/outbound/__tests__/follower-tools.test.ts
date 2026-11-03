/** @jest-environment node */
import { guardDraftTools } from '../follower-tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any =>
  ({
    draftReply: jest.fn(async () => 'r'),
    draftMessage: jest.fn(async () => 'm'),
    reviseDraft: jest.fn(async () => 'v'),
    listOutbox: jest.fn(async () => 'l'),
  });

describe('drafting on a read-only copy', () => {
  it('tells the assistant where to draft, and writes nothing', async () => {
    const inner = api();
    const g = guardDraftTools(inner, { readOnly: () => true, masterName: () => 'Work Mac' });
    for (const call of [
      () => g.draftMessage({} as never),
      () => g.draftReply({} as never),
      () => g.reviseDraft({} as never),
    ])
      await expect(call()).rejects.toThrow('Draft this on Work Mac');
    expect(inner.draftMessage).not.toHaveBeenCalled();
    expect(inner.reviseDraft).not.toHaveBeenCalled();
    // Reading is untouched.
    await expect(g.listOutbox({} as never)).resolves.toBe('l');
  });

  it('a raw SyncReadOnly that slips past the check says the same', async () => {
    const inner = api();
    (inner.draftMessage as jest.Mock).mockRejectedValue(
      Object.assign(new Error('this device is a read-only copy: x'), { name: 'SyncReadOnly' }),
    );
    const g = guardDraftTools(inner, { readOnly: () => false, masterName: () => null });
    await expect(g.draftMessage({} as never)).rejects.toThrow('Draft this on the device that leads');
  });

  it('the leader passes everything through', async () => {
    const inner = api();
    const g = guardDraftTools(inner, { readOnly: () => false, masterName: () => null });
    await expect(g.draftMessage({} as never)).resolves.toBe('m');
  });
});
