import { deriveOnboarding, step1Meta } from '../onboarding-steps';

const none = {
  sourceBackfilledAt: null,
  mcpConnectedAt: null,
  firstQueryAt: null,
  dismissedAt: null,
};
const all = {
  sourceBackfilledAt: 'a',
  mcpConnectedAt: 'b',
  firstQueryAt: 'c',
  dismissedAt: null,
};

it('visible while any step is open, steps map from latches', () => {
  expect(deriveOnboarding(none)).toEqual({
    step1Done: false,
    step2Done: false,
    step3Done: false,
    visible: true,
  });
  expect(deriveOnboarding({ ...none, mcpConnectedAt: 'b' }).step2Done).toBe(
    true,
  );
});
it('collapses when all three latch', () => {
  expect(deriveOnboarding(all).visible).toBe(false);
});
it('hidden when dismissed even with open steps', () => {
  expect(deriveOnboarding({ ...none, dismissedAt: 'd' }).visible).toBe(false);
});

const acct = (status: string) => ({
  account: { status } as never,
  docCount: 0,
  recent: [],
});
it('step1Meta variants', () => {
  expect(step1Meta([], false)).toMatch(/first source/i);
  expect(step1Meta([acct('backfilling')], false)).toMatch(/backfilling/i);
  expect(step1Meta([acct('pending')], false)).toMatch(/setting up/i);
  expect(step1Meta([acct('live')], true)).toBe('1 source connected');
  expect(step1Meta([acct('live'), acct('live')], true)).toBe(
    '2 sources connected',
  );
});
