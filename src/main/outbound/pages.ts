/**
 * Outbox confirm-surface HTML (spec §5) — variant 'minimal' pages rendered
 * from the FROZEN outbox row: what the user reviews here is exactly what the
 * app will send, no matter what a prompt-injected session claimed in chat.
 * The recipient line is the load-bearing element on every page.
 */
import { esc, renderShell } from '@shared/web-ui';
import { loadShellCss } from '@shared/web-ui/loader-node';
import type { ShellCss } from '@shared/web-ui/render-shell';
import type { OutboxRow } from '@shared/contracts';

const EMPTY_CSS: ShellCss = { tokens: '', components: '', shell: '' };
let cachedCss: ShellCss | null = null;

// loadShellCss reads tokens.css/components.css/Spark.css/shell-minimal.css
// off disk via a __dirname-relative readFileSync (see its own doc comment:
// it only promises this works for the registration service's Docker image,
// which COPYs them explicitly, and for jest, where __dirname is the real
// source tree). Nothing in this repo's Electron main webpack config copies
// those CSS files next to the compiled main bundle — confirmed empirically
// against a `npm run build:main` output (release/app/dist/main has zero
// .css files). If that gap isn't closed before this ships, render unstyled
// rather than let a missing stylesheet 500 every /outbox/* request: content
// and the POST forms are unaffected, only the <style> block goes empty.
const css = (): ShellCss => {
  if (cachedCss) return cachedCss;
  try {
    cachedCss = loadShellCss('minimal');
  } catch (err) {
    // The build fix (staging the shared web-ui CSS beside the main bundle)
    // has landed, so this SHOULD never trip in a packaged app any more — if
    // it does, that's a build regression, and the fallback that swallows it
    // must not also swallow the signal. No logSink in this module; a main-
    // process console.warn is the idiomatic fallback here (see .eslintrc.js:
    // no-console is off for exactly this kind of case).
    console.warn(
      'outbound: shared web-ui CSS missing — confirm pages render unstyled',
      err,
    );
    cachedCss = EMPTY_CSS;
  }
  return cachedCss;
};

function recipientBlock(row: OutboxRow): string {
  const cc = row.cc.length
    ? `<div class="t-meta">Cc: ${esc(row.cc.join(', '))}</div>`
    : '';
  return `<div style="margin-bottom:12px">
    <div class="t-meta">To</div>
    <div style="font-size:16px;font-weight:600">${esc(row.recipientDisplay)}</div>
    ${row.to.length > 1 ? `<div class="t-meta">${esc(row.to.join(', '))}</div>` : ''}
    ${cc}
  </div>`;
}

export function reviewPage(
  row: OutboxRow,
  p: { confirmPath: string; cancelPath: string },
): string {
  const body = `
  ${recipientBlock(row)}
  ${row.subject ? `<div style="font-weight:600;margin-bottom:8px">${esc(row.subject)}</div>` : ''}
  <pre style="white-space:pre-wrap;font-family:inherit;border:1px solid rgba(127,127,127,.3);border-radius:6px;padding:12px;max-height:50vh;overflow:auto">${esc(row.bodyMarkdown)}</pre>
  <div style="display:flex;gap:8px;margin-top:16px">
    <form method="POST" action="${esc(p.confirmPath)}"><button type="submit" class="btn">Confirm &amp; send</button></form>
    <form method="POST" action="${esc(p.cancelPath)}"><button type="submit" class="btn sm">Cancel</button></form>
  </div>`;
  return renderShell(css(), {
    title: 'Review and send',
    variant: 'minimal',
    body,
  });
}

export function linkPage(row: OutboxRow, p: { confirmPath: string }): string {
  const body = `
  ${recipientBlock(row)}
  <form method="POST" action="${esc(p.confirmPath)}">
    <button type="submit" class="btn">Send</button>
  </form>`;
  return renderShell(css(), {
    title: 'Send message?',
    variant: 'minimal',
    body,
  });
}

export function resultPage(title: string, message: string): string {
  return renderShell(css(), {
    title,
    variant: 'minimal',
    body: `<p>${esc(message)}</p>`,
  });
}
