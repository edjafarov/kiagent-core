import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Toggle, Checkbox } from '..';

describe('Toggle', () => {
  it('is a switch that reports the next state', () => {
    const onChange = jest.fn();
    render(
      <Toggle
        aria-label="Launch at login"
        checked={false}
        onChange={onChange}
      />,
    );
    const sw = screen.getByRole('switch', { name: 'Launch at login' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does nothing while disabled', () => {
    const onChange = jest.fn();
    render(<Toggle aria-label="X" checked onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'X' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox', () => {
  it('is labelled by its text and reports the next state', () => {
    const onChange = jest.fn();
    render(<Checkbox label="Zoom" checked={false} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Zoom' });
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
