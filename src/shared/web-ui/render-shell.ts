import { esc } from './esc';
import { sparkHtml } from './spark-html';
import { sparkSvgMarkup } from './spark-geometry';

export type ShellVariant = 'hero' | 'app' | 'minimal';

export interface ShellCss {
  tokens: string;
  components: string;
  shell: string;
}

export interface RenderShellOpts {
  title: string;
  variant: ShellVariant;
  body: string;
  hero?: { tagline: string; sub: string };
  errorCode?: string;
  meta?: { description?: string };
  mainModifier?: 'wide';
  wordmark?: string;
}

export function renderShell(css: ShellCss, opts: RenderShellOpts): string {
  const head = renderHead(css, opts);
  const inner = renderVariant(opts);
  return `<!doctype html>
<html lang="en">
${head}
<body>
${inner}
</body>
</html>`;
}

function renderHead(css: ShellCss, opts: RenderShellOpts): string {
  const desc = opts.meta?.description
    ? `<meta name="description" content="${esc(opts.meta.description)}">`
    : '';
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
${desc}
<style>${css.tokens}\n${css.components}\n${css.shell}</style>
</head>`;
}

function renderVariant(opts: RenderShellOpts): string {
  if (opts.variant === 'hero') {
    if (!opts.hero) {
      throw new Error(
        "renderShell: variant='hero' requires hero={tagline,sub}",
      );
    }
    return `<div class="sh-hero">
  <aside class="sh-hero__brand" aria-hidden="true">
    ${sparkHtml({ size: 'hero', dark: true })}
    <div class="sh-hero__brand-copy">
      <div class="sh-hero__tagline">${esc(opts.hero.tagline)}</div>
      <div class="sh-hero__sub">${esc(opts.hero.sub)}</div>
    </div>
  </aside>
  <main class="sh-hero__pane">
    <div class="sh-hero__pane-head">
      <h1 class="sh-hero__title">${esc(opts.title)}</h1>
    </div>
    <div class="sh-hero__content">${opts.body}</div>
    ${renderFoot(opts)}
  </main>
</div>`;
  }

  if (opts.variant === 'app') {
    const wide = opts.mainModifier === 'wide' ? ' sh-app__main--wide' : '';
    return `<div class="sh-app">
  <header class="sh-app__topbar">
    <span class="sh-app__brand">
      ${sparkSvgMarkup({ frame: true, className: 'sh-app__brand-mark' })}${opts.wordmark ?? 'kia'}
    </span>
    <span class="sh-app__spacer"></span>
  </header>
  <main class="sh-app__main${wide}">
    <h1 class="sh-app__h1">${esc(opts.title)}</h1>
    ${opts.body}
  </main>
</div>`;
  }

  // minimal
  return `<div class="sh-min">
  <div class="sh-min__card">
    <h1 class="sh-min__h1">${esc(opts.title)}</h1>
    <div class="sh-min__body">${opts.body}</div>
    ${renderFoot(opts)}
  </div>
</div>`;
}

function renderFoot(opts: RenderShellOpts): string {
  if (!opts.errorCode) return '';
  const cls = opts.variant === 'minimal' ? 'sh-min__foot' : 'sh-hero__foot';
  const pillCls =
    opts.variant === 'minimal' ? 'sh-min__error-pill' : 'sh-hero__error-pill';
  return `<div class="${cls}"><span class="${pillCls}">error: ${esc(opts.errorCode)}</span></div>`;
}
