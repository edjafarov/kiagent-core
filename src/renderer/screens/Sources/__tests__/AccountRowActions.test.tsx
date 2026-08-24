import '@testing-library/jest-dom';
import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AccountId } from '@shared/contracts';
import { AccountRowActions } from '../AccountRowActions';

/**
 * `accounts:remove` is ONE synchronous transactional cascade in the DB
 * worker (write-tx.ts `removeAccount`): every FTS row, every trigram row and
 * every document for the account go in a single BEGIN..COMMIT, and nothing
 * is observable until it commits. On a real corpus that ran ~5 minutes for
 * 3.73M documents with no intermediate state to show.
 *
 * So the confirm dialog IS the only progress signal there can be, and the
 * kebab-menu caller used to throw it away: it closed the modal and then
 * `void`ed the invoke, so `await onConfirm()` inside RemoveAccountModal
 * resolved on the same tick and the busy state could never engage. The user
 * clicked Remove, the dialog vanished, and the app looked hung.
 */

const account = { id: 'a1' as AccountId, identifier: 'this-machine' };

function openRemoveDialog(): void {
  fireEvent.click(
    screen.getByRole('button', { name: 'Actions for this-machine' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
}

const CONFIRM = 'Remove and delete indexed data';

describe('AccountRowActions remove flow', () => {
  test('modal stays open in a busy state until the cascade settles', async () => {
    let settle = (): void => {};
    const invoke = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    (window as unknown as { kiagent: unknown }).kiagent = { invoke };

    render(<AccountRowActions account={account} />);
    openRemoveDialog();
    fireEvent.click(screen.getByRole('button', { name: CONFIRM }));

    // Still running: the dialog must survive and say so.
    expect(invoke).toHaveBeenCalledWith('accounts:remove', {
      accountId: 'a1',
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText(/Removing…/)).toBeInTheDocument();

    // ...and it must warn that this is not a quick operation, because it
    // isn't — quitting mid-cascade rolls the whole transaction back.
    expect(screen.getByRole('dialog')).toHaveTextContent(/several minutes/i);
    expect(screen.getByRole('dialog')).toHaveTextContent(/keep the app open/i);

    await act(async () => {
      settle();
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  test('both buttons are disabled while the cascade runs — it cannot be called back', async () => {
    (window as unknown as { kiagent: unknown }).kiagent = {
      invoke: jest.fn(() => new Promise<void>(() => {})),
    };

    render(<AccountRowActions account={account} />);
    openRemoveDialog();
    fireEvent.click(screen.getByRole('button', { name: CONFIRM }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Removing…/ })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    // Escape and backdrop must not dismiss it either.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
