import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SignIn } from '../SignIn';

const invoke = jest.fn();

function setup() {
  invoke.mockReset();
  (window as unknown as { kiagent: unknown }).kiagent = { invoke };
  render(<SignIn />);
}

const name = () => screen.getByRole('textbox', { name: 'Name' });
const email = () => screen.getByRole('textbox', { name: 'Email' });
const submit = () => screen.getByRole('button', { name: 'Sign in' });

describe('core SignIn', () => {
  it('needs both fields before it can submit', () => {
    setup();
    expect(submit()).toBeDisabled();
    fireEvent.change(name(), { target: { value: 'Ada' } });
    expect(submit()).toBeDisabled();
    fireEvent.change(email(), { target: { value: 'ada@example.com' } });
    expect(submit()).toBeEnabled();
  });

  it('sets the identity with trimmed values', async () => {
    setup();
    invoke.mockResolvedValue(undefined);
    fireEvent.change(name(), { target: { value: '  Ada ' } });
    fireEvent.change(email(), { target: { value: ' ada@example.com ' } });
    fireEvent.click(submit());
    expect(invoke).toHaveBeenCalledWith('identity:set', {
      name: 'Ada',
      emails: ['ada@example.com'],
      phones: [],
    });
    expect(
      await screen.findByRole('button', { name: 'Signing in…' }),
    ).toBeDisabled();
  });

  it('a failure says so and lets the person try again', async () => {
    setup();
    invoke.mockRejectedValue(new Error('disk full'));
    fireEvent.change(name(), { target: { value: 'Ada' } });
    fireEvent.change(email(), { target: { value: 'ada@example.com' } });
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't sign you in — disk full",
    );
    expect(submit()).toBeEnabled();
  });
});
