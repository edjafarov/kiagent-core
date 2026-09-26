import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { Sheet, ConfirmSheet } from '..';

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'ac';
  document.body.appendChild(host);
});
afterEach(() => {
  host.remove();
});

function open(extra: Partial<React.ComponentProps<typeof Sheet>> = {}) {
  const onClose = jest.fn();
  render(
    <Sheet
      title="Review draft"
      onClose={onClose}
      footer={<button type="button">Send</button>}
      {...extra}
    >
      <input aria-label="Subject" />
    </Sheet>,
  );
  return {
    onClose,
    dialog: screen.getByRole('dialog', { name: 'Review draft' }),
  };
}

describe('Sheet', () => {
  it('renders a labelled modal dialog inside .ac', () => {
    const { dialog } = open();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(host.contains(dialog)).toBe(true);
  });

  it('moves focus to the first field and traps Tab', () => {
    open();
    const subject = screen.getByRole('textbox', { name: 'Subject' });
    expect(subject).toHaveFocus();
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    fireEvent.keyDown(send, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), {
      key: 'Tab',
      shiftKey: true,
    });
    expect(send).toHaveFocus();
  });

  it('closes on Esc, but not while busy', () => {
    const { onClose, dialog } = open();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores Esc while busy', () => {
    const { onClose, dialog } = open({ busy: true });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a backdrop press-and-release only', () => {
    const { onClose, dialog } = open();
    const scrim = dialog.parentElement!;
    fireEvent.mouseDown(dialog);
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the opener when it unmounts', () => {
    function Opener() {
      const [isOpen, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          {isOpen && (
            <Sheet title="T" onClose={() => setOpen(false)}>
              <button type="button">Inner</button>
            </Sheet>
          )}
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: 'Inner' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(opener).toHaveFocus();
  });
});

describe('ConfirmSheet', () => {
  it('runs the confirm, locks while busy, then closes', async () => {
    let resolve!: () => void;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const onClose = jest.fn();
    render(
      <ConfirmSheet
        title="Remove Gmail?"
        confirmLabel="Remove"
        tone="danger"
        onConfirm={onConfirm}
        onClose={onClose}
      >
        Its documents leave your memory.
      </ConfirmSheet>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the failure and stays open', async () => {
    const onClose = jest.fn();
    render(
      <ConfirmSheet
        title="Remove?"
        confirmLabel="Remove"
        onConfirm={() => Promise.reject(new Error('database busy'))}
        onClose={onClose}
      >
        Sure?
      </ConfirmSheet>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('database busy');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove' })).not.toBeDisabled();
  });

  it('says what it is doing while busy, when given the words', async () => {
    let resolve!: () => void;
    render(
      <ConfirmSheet
        title="Remove?"
        confirmLabel="Remove"
        busyLabel="Removing…"
        onConfirm={() =>
          new Promise<void>((r) => {
            resolve = r;
          })
        }
        onClose={() => {}}
      >
        Sure?
      </ConfirmSheet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
    await act(async () => resolve());
  });
});
