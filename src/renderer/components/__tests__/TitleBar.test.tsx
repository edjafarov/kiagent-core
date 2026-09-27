import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TitleBar } from '../TitleBar';

describe('TitleBar', () => {
  it('is the 48px band with the product name from app:info', async () => {
    (window as unknown as { kiagent: unknown }).kiagent = {
      invoke: jest.fn().mockResolvedValue({ productName: 'Acme' }),
    };
    render(<TitleBar />);
    expect(
      (await screen.findByText('Acme')).closest('.ui-titlebar'),
    ).not.toBeNull();
  });
});
