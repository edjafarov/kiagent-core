import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { GateLayout } from '../GateLayout';
import { BootSplash } from '../BootSplash';

describe('GateLayout', () => {
  it('shows the form with the default footer; the brand panel is decoration', () => {
    const { container } = render(
      <GateLayout tagline="Tag line" blurb="A blurb">
        <h1>Form</h1>
      </GateLayout>,
    );
    expect(screen.getByRole('heading', { name: 'Form' })).toBeInTheDocument();
    expect(
      screen.getByText('No telemetry · your data stays local'),
    ).toBeInTheDocument();
    const brand = container.querySelector('.gate-brand');
    expect(brand).toHaveAttribute('aria-hidden', 'true');
    expect(brand).toHaveTextContent('Tag line');
    expect(brand).toHaveTextContent('A blurb');
  });

  it('takes a footer of its own', () => {
    render(
      <GateLayout tagline="t" blurb="b" footer="Own footer">
        <div />
      </GateLayout>,
    );
    expect(screen.getByText('Own footer')).toBeInTheDocument();
    expect(screen.queryByText(/No telemetry/)).not.toBeInTheDocument();
  });
});

describe('BootSplash', () => {
  it('is a status named after the product', async () => {
    (window as unknown as { kiagent: unknown }).kiagent = {
      invoke: jest.fn().mockResolvedValue({ productName: 'Acme' }),
    };
    render(<BootSplash />);
    expect(
      await screen.findByRole('status', { name: 'Loading Acme' }),
    ).toBeInTheDocument();
  });
});
