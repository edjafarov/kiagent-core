import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { TitleBar } from '../TitleBar';

describe('TitleBar', () => {
  it('is the 48px band with the product name', () => {
    render(<TitleBar />);
    expect(screen.getByText('KIAgent').closest('.ui-titlebar')).not.toBeNull();
  });
});
