import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  BrandGlyph,
  BrandMark,
  DateTile,
  Avatar,
  Chip,
  sourceBrand,
  clientBrand,
} from '..';

describe('BrandGlyph', () => {
  it('draws the table icon on the brand colour, decorative by default', () => {
    const { container } = render(
      <BrandGlyph brand={sourceBrand('gmail')} size={20} />,
    );
    const glyph = container.firstChild as HTMLElement;
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph.style.getPropertyValue('--brand')).toBe('#d93025');
    expect(glyph.querySelector('use')).toHaveAttribute('href', '#i-mail');
  });

  it('shows initials for an AI app and can be named', () => {
    render(
      <BrandGlyph brand={clientBrand('claude-code')} label="Claude Code" />,
    );
    expect(screen.getByRole('img', { name: 'Claude Code' })).toHaveTextContent(
      'CC',
    );
  });

  it('shows a connector image on a white square', () => {
    const { container } = render(
      <BrandGlyph
        brand={sourceBrand('acme', { iconDataUrl: 'data:image/png;base64,AA' })}
      />,
    );
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,AA',
    );
    expect(container.firstChild).toHaveClass('is-img');
  });
});

describe('BrandMark', () => {
  it('is a decorative stripe in the brand colour', () => {
    const { container } = render(<BrandMark brand={sourceBrand('slack')} />);
    const mark = container.firstChild as HTMLElement;
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark.style.getPropertyValue('--brand')).toBe('#4a154b');
  });
});

describe('DateTile', () => {
  it('shows the day and short month', () => {
    render(<DateTile date={new Date(2026, 8, 24)} today />);
    expect(screen.getByText('24')).toBeInTheDocument();
    expect(screen.getByText('Sep')).toBeInTheDocument();
  });
});

describe('Avatar and Chip', () => {
  it('renders the initial', () => {
    const { container } = render(<Avatar name="alex morgan" />);
    expect(container).toHaveTextContent('A');
  });

  it('renders a chip button with name and count', () => {
    const onClick = jest.fn();
    render(
      <Chip
        brand={sourceBrand('notion')}
        name="Notion"
        count={3}
        onClick={onClick}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Notion/ }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
