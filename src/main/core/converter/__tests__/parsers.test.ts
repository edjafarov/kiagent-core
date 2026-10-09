/** @jest-environment node */
import fs from 'fs';
import path from 'path';

import { DEFAULT_SCALE, rasterScale } from '../parsers';

it('parsers.ts imports nothing from electron, the store, the engine or the log sink', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'parsers.ts'), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const spec of imports)
    expect(spec).not.toMatch(/electron|\/store\/|\/logs|engine\/engine/);
});

describe('rasterScale', () => {
  const letter = { originalWidth: 612, originalHeight: 792 };
  it('without maxEdge renders at today’s 2× (OCR reads full-size pages)', () => {
    expect(rasterScale(letter)).toBe(DEFAULT_SCALE);
  });
  it('with maxEdge picks the scale whose longest edge is maxEdge', () => {
    expect(rasterScale(letter, 896)).toBeCloseTo(896 / 792, 6);
  });
  it('never upscales past 2× (the old path only ever shrank)', () => {
    expect(rasterScale({ originalWidth: 100, originalHeight: 120 }, 896)).toBe(
      DEFAULT_SCALE,
    );
  });
  it('a degenerate page size falls back to 2×', () => {
    expect(rasterScale({ originalWidth: 0, originalHeight: 0 }, 896)).toBe(
      DEFAULT_SCALE,
    );
  });
});
