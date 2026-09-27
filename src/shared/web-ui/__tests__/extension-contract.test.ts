import { readFileSync } from 'fs';
import path from 'path';

// The README's stable list is a promise to extension pages: every name in it
// must still be styled by the host.
const dir = path.join(__dirname, '..');
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const readme = read('README.md');

function listed(marker: string, pattern: RegExp): string[] {
  const block = readme
    .split(`<!-- ${marker} -->`)[1]
    ?.split(`<!-- /${marker} -->`)[0];
  if (!block) throw new Error(`README has no ${marker} block`);
  return [...block.matchAll(pattern)].map((m) => m[1]);
}

test('every stable token is defined in tokens.css', () => {
  const tokens = listed('stable-tokens', /`(--[a-z0-9-]+)`/g);
  expect(tokens.length).toBeGreaterThan(10);
  const css = read('tokens.css');
  const missing = tokens.filter((t) => !new RegExp(`${t}\\s*:`).test(css));
  expect(missing).toEqual([]);
});

test('every stable class is styled in ui.css', () => {
  const classes = listed('stable-classes', /`((?:ui|is)-[a-z0-9-]+)`/g);
  expect(classes).toContain('ui-btn');
  const css = read('ui.css');
  const missing = classes.filter(
    (c) => !new RegExp(`\\.${c}(?![\\w-])`).test(css),
  );
  expect(missing).toEqual([]);
});
