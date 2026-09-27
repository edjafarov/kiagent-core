import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Account } from '../Account';

const identity = {
  name: 'Alex Morgan',
  emails: ['alex@example.com'],
  avatarUrl: null,
};
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel({ identity }),
}));

const invoke = jest.fn();
beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
});

describe('core Account pane', () => {
  it('shows the identity with Edit', () => {
    render(<Account />);
    expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
    expect(screen.getByText('alex@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('edit → save writes identity:set with trimmed values', async () => {
    render(<Account />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Sam Lee ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add email' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email 2' }), {
      target: { value: ' sam@example.com ' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(invoke).toHaveBeenCalledWith('identity:set', {
      ...identity,
      name: 'Sam Lee',
      emails: ['alex@example.com', 'sam@example.com'],
    });
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('cancel drops the edits', () => {
    render(<Account />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Other' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});
