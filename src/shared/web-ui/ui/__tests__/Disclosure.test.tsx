import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Disclosure } from '..';

describe('Disclosure', () => {
  it('starts closed, opens on click and shows the summary', () => {
    render(
      <Disclosure label="Advanced" summary="Port 7421">
        <p>hidden body</p>
      </Disclosure>,
    );
    const head = screen.getByRole('button', { name: /Advanced/ });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Port 7421')).toBeInTheDocument();
    expect(screen.queryByText('hidden body')).not.toBeInTheDocument();
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    const body = screen.getByText('hidden body').parentElement!;
    expect(head).toHaveAttribute('aria-controls', body.id);
  });

  it('can start open', () => {
    render(
      <Disclosure label="Details" defaultOpen>
        <p>shown</p>
      </Disclosure>,
    );
    expect(screen.getByText('shown')).toBeInTheDocument();
  });

  it('reports toggles in controlled mode and follows the prop', () => {
    const onToggle = jest.fn();
    const { rerender } = render(
      <Disclosure label="Details" open={false} onToggle={onToggle}>
        <p>body</p>
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    rerender(
      <Disclosure label="Details" open onToggle={onToggle}>
        <p>body</p>
      </Disclosure>,
    );
    expect(screen.getByText('body')).toBeInTheDocument();
  });
});
