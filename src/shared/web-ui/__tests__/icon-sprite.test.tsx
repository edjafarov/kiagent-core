import '@testing-library/jest-dom';
import React from 'react';
import { render } from '@testing-library/react';
import { Icon, IconSprite, ICON_NAMES } from '../icon-sprite';

const ADDED = [
  'bell',
  'inbox',
  'send',
  'clock',
  'globe',
  'key',
  'sliders',
  'download',
  'undo',
  'arrow-left',
  'monitor',
  'cpu',
  'hard-drive',
  'file-text',
  'filter',
  'activity',
  'zap',
  'message',
  'folder-open',
  'lock',
  'arrow-up-right',
  'list',
  'grid',
  'chev-up',
  'chev-left',
  'edit',
  'sparkles',
  'bot',
  'power',
  'upload',
  'user-plus',
  'moon',
  'wave',
  'home',
  'calendar',
  'users',
  'layers',
  'mic',
  'square',
];

describe('icon sprite', () => {
  it.each(ADDED)('has a drawn %s symbol', (name) => {
    expect(ICON_NAMES.has(name)).toBe(true);
    const { container } = render(<IconSprite />);
    const symbol = container.querySelector(`symbol#i-${name}`)!;
    expect(symbol).not.toBeNull();
    expect(symbol.childElementCount).toBeGreaterThan(0);
  });

  it('carries the stroke width on the icon, not the symbol', () => {
    const { container } = render(
      <>
        <IconSprite />
        <Icon name="bell" />
      </>,
    );
    expect(container.querySelector('symbol#i-bell')).not.toHaveAttribute(
      'stroke-width',
    );
    expect(container.querySelector('svg.i')).toHaveAttribute(
      'stroke-width',
      '1.5',
    );
  });
});
