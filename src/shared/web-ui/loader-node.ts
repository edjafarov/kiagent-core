import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShellVariant, ShellCss } from './render-shell';

const cache = new Map<ShellVariant, ShellCss>();

function readCss(name: string): string {
  // __dirname at runtime resolves to the directory containing the compiled
  // loader-node.js (e.g. dist/src/shared/web-ui/). The CSS files sit alongside
  // (Dockerfile copies them; tests find them in the source tree).
  return readFileSync(join(__dirname, name), 'utf8');
}

export function loadShellCss(variant: ShellVariant): ShellCss {
  const hit = cache.get(variant);
  if (hit) return hit;
  const css: ShellCss = {
    tokens: readCss('tokens.css'),
    components: `${readCss('components.css')}\n${readCss('Spark.css')}`,
    shell: readCss(`shell-${variant}.css`),
  };
  cache.set(variant, css);
  return css;
}
