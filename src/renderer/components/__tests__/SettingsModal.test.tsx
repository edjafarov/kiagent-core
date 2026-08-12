import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsModal } from '../SettingsModal';

// Settings composes five IPC-heavy panes; the modal contract (open, close on
// ✕/Esc/backdrop, dialog role) is independent of pane internals.
jest.mock('@renderer/screens/Settings', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    Settings: () => R.createElement('div', { 'data-testid': 'settings-body' }),
  };
});

describe('SettingsModal', () => {
  it('renders a dialog containing the Settings screen', () => {
    render(<SettingsModal onClose={jest.fn()} />);
    expect(
      screen.getByRole('dialog', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('settings-body')).toBeInTheDocument();
  });

  it('closes on the ✕ button', () => {
    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click but not on dialog click', () => {
    const onClose = jest.fn();
    render(<SettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('settings-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog', { name: 'Settings' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
