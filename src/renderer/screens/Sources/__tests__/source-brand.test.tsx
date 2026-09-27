import '@testing-library/jest-dom';
import React from 'react';
import { render, renderHook } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { SourceGlyph, useSourceBrand } from '../source-brand';
import { sourceLabel } from '../source-label';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({
      extensions: [
        {
          id: 'kia.slack',
          sourceIds: ['slack'],
          iconDataUrl: 'data:image/png;base64,AAAA',
        },
        {
          id: 'acme.widgets',
          sourceIds: ['widgets'],
          iconDataUrl: 'data:image/png;base64,BBBB',
        },
      ],
    } as unknown as AppState),
}));

describe('useSourceBrand', () => {
  test('a known source draws the brands table, even with an extension icon', () => {
    const { result } = renderHook(() => useSourceBrand('slack'));
    expect(result.current.key).toBe('slack');
    expect(result.current.color).not.toBeNull();
    expect(result.current.imageUrl).toBeUndefined();
  });

  test('an unknown source draws its extension icon', () => {
    const { result } = renderHook(() => useSourceBrand('widgets', 'Widgets'));
    expect(result.current).toMatchObject({
      name: 'Widgets',
      imageUrl: 'data:image/png;base64,BBBB',
    });
  });

  test('an unknown source without an icon is a neutral square with initials', () => {
    const { result } = renderHook(() => useSourceBrand('mystery', 'Mystery'));
    expect(result.current).toMatchObject({ color: null, initials: 'My' });
  });

  test('SourceGlyph renders the brand glyph', () => {
    const { container } = render(<SourceGlyph sourceId="gmail" size={32} />);
    expect(container.querySelector('.ui-glyph')).toBeInTheDocument();
  });
});

describe('sourceLabel', () => {
  test('the descriptor name when registered, else a title-cased id', () => {
    const descriptors = [{ id: 'gmail', name: 'Gmail' }] as never;
    expect(sourceLabel('gmail', descriptors)).toBe('Gmail');
    expect(sourceLabel('local-folder', null)).toBe('Local Folder');
  });
});
