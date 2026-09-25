import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.resolve(__dirname, '../tokens.css'), 'utf8');
const start = css.indexOf(':root {');
const root = css.slice(start, css.indexOf('\n}', start));

function token(name: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`).exec(root);
  return m?.[1].trim();
}

const EXPECTED: Record<string, string> = {
  '--text-tertiary': '#6b7686',
  '--error-solid': '#be123c',
  '--working-solid': '#b45309',
  '--band-bg': '#ffffff',
  '--band-border': '#ececf1',
  '--card-bg': '#ffffff',
  '--card-edge': '#e8e9ee',
  '--field-border': '#e2e4ea',
  '--band-quiet': '#f4f4f7',
  '--row-sel': '#f3f0fc',
  '--row-hover': '#f4f1fd',
  '--track': '#eeeef3',
  '--hair': '#eef0f3',
  '--accent-deep': 'var(--brand-violet-deep)',
  '--label-color': 'var(--accent-text)',
  '--nav-text': '#52525b',
  '--nav-active': '#5b21b6',
  '--r-card': '4px',
  '--r-alert': '3px',
  '--r-field': '3px',
  '--r-xs': '2px',
  '--sidebar-w': '224px',
  '--band-h': '48px',
  '--pane-pad': '24px 32px',
  '--gap-page': '20px',
  '--gap-stack': '16px',
  '--aside-sm': '336px',
  '--aside-md': '400px',
  '--card-pad': '16px 20px',
  '--row-h': '30px',
  '--row-h-l': '34px',
  '--row-h-mid': '38px',
  '--row-h-tall': '42px',
  '--row-h-xl': '48px',
  '--brand-tone': '84%',
  '--brand-mute': '#64748b',
};

describe('tokens.css', () => {
  it.each(Object.entries(EXPECTED))('%s is %s', (name, value) => {
    expect(token(name)).toBe(value);
  });

  it('keeps the legacy radius tokens square', () => {
    for (const r of ['sm', 'md', 'lg', 'xl']) {
      expect(token(`--radius-${r}`)).toBe('0');
    }
  });
});
