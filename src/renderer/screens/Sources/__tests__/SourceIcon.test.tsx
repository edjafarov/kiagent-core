import '@testing-library/jest-dom';
import React from 'react';
import { render } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { SourceIcon } from '../SourceIcon';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({
      extensions: [
        {
          id: 'kia.slack',
          sourceIds: ['slack'],
          iconDataUrl: 'data:image/png;base64,AAAA',
        },
        { id: 'kia.notion', sourceIds: ['notion'] }, // no icon in manifest
      ],
    } as unknown as AppState),
}));

describe('SourceIcon', () => {
  test('renders the contributing extension brand icon for its source id', () => {
    const { container } = render(<SourceIcon sourceId="slack" size={24} />);
    const img = container.querySelector('img.ext-glyph-img');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  test('renders the bundled brand mark for the builtin gmail source', () => {
    const { container } = render(<SourceIcon sourceId="gmail" size={24} />);
    const img = container.querySelector('img.ext-glyph-img');
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  test('falls back to the sprite glyph for non-brand builtins and iconless extensions', () => {
    for (const sourceId of ['local-folder', 'notion']) {
      const { container, unmount } = render(
        <SourceIcon sourceId={sourceId} size={24} />,
      );
      expect(container.querySelector('img')).not.toBeInTheDocument();
      expect(container.querySelector('svg')).toBeInTheDocument();
      unmount();
    }
  });
});
