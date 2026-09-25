import type { AppStatePush } from '@shared/ipc';
import type { PageAppState } from '../../../sdk/connector-sdk/ui';

// The SDK's page types are hand-written; this pins them to what core's
// `app:get-state` / `push:app-state` actually send. A drift is a compile
// error here, which ts-jest reports as a failing suite.
const asPage = (p: AppStatePush): PageAppState => p;

test('a page reads accounts from the app-state envelope', () => {
  const push = {
    state: {
      accounts: [
        {
          account: { id: 'a1', source: 'google-calendar', identifier: 'me' },
        },
      ],
    },
    seq: 1,
    rev: 1,
  } as unknown as AppStatePush;
  expect(asPage(push).state.accounts[0].account.source).toBe('google-calendar');
});
