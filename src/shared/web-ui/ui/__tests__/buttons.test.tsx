import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Button, IconButton, TextButton } from '..';

describe('Button', () => {
  it('is a type=button with its variant and optional icon', () => {
    const onClick = jest.fn();
    render(
      <Button variant="primary" icon="plus" onClick={onClick}>
        Add source
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Add source' });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveClass('is-primary');
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-plus');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('defaults to secondary and forwards refs and disabled', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} disabled>
        Save
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Save' }));
    expect(ref.current).toHaveClass('is-secondary');
    expect(ref.current).toBeDisabled();
  });
});

describe('IconButton', () => {
  it('is named by its label', () => {
    render(<IconButton icon="settings" label="Settings" />);
    const btn = screen.getByRole('button', { name: 'Settings' });
    expect(btn).toHaveAttribute('title', 'Settings');
    expect(btn.querySelector('use')).toHaveAttribute('href', '#i-settings');
  });
});

describe('TextButton', () => {
  it('is an inline text button', () => {
    const onClick = jest.fn();
    render(<TextButton onClick={onClick}>See all</TextButton>);
    fireEvent.click(screen.getByRole('button', { name: 'See all' }));
    expect(onClick).toHaveBeenCalled();
  });
});
