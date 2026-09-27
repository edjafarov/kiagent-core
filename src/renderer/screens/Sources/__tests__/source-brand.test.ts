import { sourceBrandOf } from '../source-brand';
import { sourceLabel } from '../source-label';

const extensions = [
  { sourceIds: ['slack'], iconDataUrl: 'data:image/png;base64,AAAA' },
  { sourceIds: ['widgets'], iconDataUrl: 'data:image/png;base64,BBBB' },
];

describe('sourceBrandOf', () => {
  test('a known source draws the brands table, even with an extension icon', () => {
    const brand = sourceBrandOf('slack', 'Slack', extensions);
    expect(brand.key).toBe('slack');
    expect(brand.color).not.toBeNull();
    expect(brand.imageUrl).toBeUndefined();
  });

  test('an unknown source draws its extension icon', () => {
    expect(sourceBrandOf('widgets', 'Widgets', extensions)).toMatchObject({
      name: 'Widgets',
      imageUrl: 'data:image/png;base64,BBBB',
    });
  });

  test('an unknown source without an icon is a neutral square with initials', () => {
    expect(sourceBrandOf('mystery', 'Mystery', extensions)).toMatchObject({
      color: null,
      initials: 'My',
    });
  });
});

describe('sourceLabel', () => {
  test('the descriptor name when registered, else a title-cased id', () => {
    const descriptors = [{ id: 'gmail', name: 'Gmail' }] as never;
    expect(sourceLabel('gmail', descriptors)).toBe('Gmail');
    expect(sourceLabel('local-folder', null)).toBe('Local Folder');
  });
});
