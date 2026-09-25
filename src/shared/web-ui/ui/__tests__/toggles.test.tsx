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

describe('native props', () => {
  it('pass through to the switch and the checkbox, and refs forward', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <>
        <p id="hint">Starts quietly.</p>
        <Toggle
          ref={ref}
          id="t"
          aria-label="T"
          aria-describedby="hint"
          checked
          onChange={() => {}}
        />
        <Checkbox
          name="apps"
          aria-label="Zoom"
          checked={false}
          onChange={() => {}}
        />
      </>,
    );
    const sw = screen.getByRole('switch', { name: 'T' });
    expect(ref.current).toBe(sw);
    expect(sw).toHaveAttribute('id', 't');
    expect(sw).toHaveAccessibleDescription('Starts quietly.');
    expect(screen.getByRole('checkbox', { name: 'Zoom' })).toHaveAttribute(
      'name',
      'apps',
    );
  });
});
