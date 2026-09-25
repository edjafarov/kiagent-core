import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Status, ProgressBar, Spinner, Busy, type StatusTone } from '..';

describe('Status', () => {
  const tones: StatusTone[] = ['ok', 'work', 'err', 'off', 'rec'];
  it.each(tones)('renders a dot and a word for %s', (tone) => {
    const { container } = render(<Status tone={tone}>Word {tone}</Status>);
    expect(screen.getByText(`Word ${tone}`)).toBeInTheDocument();
    const dot = container.querySelector('.ui-dot')!;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstChild).toHaveClass(`is-${tone}`);
  });
});

describe('ProgressBar', () => {
  it('exposes a clamped percentage', () => {
    render(<ProgressBar aria-label="Import" value={1.4} />);
    expect(screen.getByRole('progressbar', { name: 'Import' })).toHaveAttribute(
      'aria-valuenow',
      '100',
    );
  });

  it('sets the brand colour for a first-import bar', () => {
    const { container } = render(
      <ProgressBar aria-label="Gmail" value={0.4} brand="#d93025" />,
    );
    const bar = container.querySelector('.ui-bar') as HTMLElement;
    expect(bar.style.getPropertyValue('--brand')).toBe('#d93025');
    expect(bar.style.width).toBe('40%');
  });
});

describe('re-exports', () => {
  it('exposes Spinner and Busy', () => {
    expect(typeof Spinner).toBe('function');
    expect(typeof Busy).toBe('function');
  });
});
