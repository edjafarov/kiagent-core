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

import type { ShapedOutboundError } from './error-copy';

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

export type OutboxIcon = 'success' | 'warn' | 'error' | 'info';

// Local status colors: tokens.css is a single light palette with no
// success/warn entries (see spec §4) — these stay scoped to outbox pages.
const OUTBOX_CSS = `
.ob { display: flex; flex-direction: column; gap: 14px; }
.sh-min__card { max-width: 520px; width: 100%; }
.ob-to-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
.ob-to-name { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.ob-to-list { font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.ob-subject { font-size: 15px; font-weight: 600; }
.ob-body { white-space: pre-wrap; font-family: inherit; font-size: 14px; line-height: 1.55;
  color: var(--text-primary); background: var(--bg-muted);
  border: 1px solid var(--border-subtle); border-radius: 8px;
  padding: 12px 14px; max-height: 50vh; overflow: auto; margin: 0; }
.ob-actions { display: flex; flex-direction: column; gap: 10px;
  position: sticky; bottom: 0; background: var(--bg-canvas); padding: 10px 0 2px; }
.ob-actions form { margin: 0; }
.ob-btn { height: 48px; width: 100%; font-size: 16px; border-radius: 10px; }
.ob-btn-secondary { height: 44px; width: 100%; font-size: 15px; border-radius: 10px; }
.ob-status { min-height: 20px; display: flex; gap: 8px; align-items: center;
  justify-content: center; font-size: 13px; color: var(--text-secondary); }
.ob-icon { width: 44px; height: 44px; }
.ob-msg { font-size: 14px; line-height: 1.6; color: var(--text-primary); margin: 0; }
.ob-note { font-size: 13px; color: var(--text-secondary); margin: 0; }
.ob-detail { font-size: 12px; color: var(--text-secondary); }
.ob-detail summary { cursor: pointer; }
.ob-detail pre { white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--font-mono); font-size: 11px; background: var(--bg-muted);
  border: 1px solid var(--border-subtle); border-radius: 6px;
  padding: 8px 10px; margin: 6px 0 0; }
@media (max-width: 480px) {
  .sh-min { align-items: flex-start; padding-top: 40px; }
}
`;

const ICON_SVGS: Record<OutboxIcon, string> = {
  success: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m8.2 12.4 2.6 2.6 5-5.4"/></svg>`,
  warn: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 21.5 20h-19L12 3.5Z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/></svg>`,
  error: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#e11d48" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m9 9 6 6M15 9l-6 6"/></svg>`,
  info: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5"/><path d="M12 7.6v.1"/></svg>`,
};

// Progressive enhancement (spec §4): flip the page into a Sending state on
// submit and LET THE NATIVE POST NAVIGATION PROCEED — no fetch, no JSON
// mode. The staged status text is time-based; its schedule matches the
// server's real backoff (first retry ~1s, exhausted ~8s). The disable is
// deferred a tick: disabling a submit button synchronously inside its own
// submit event can cancel form submission in some engines. `pageshow`
// resets state when bfcache restores the page after back-navigation.
const CONFIRM_SCRIPT = `<script>(function () {
  var form = document.getElementById('ob-send');
  if (!form) return;
  var statusEl = document.getElementById('ob-status');
  var timers = [];
  function controls() { return document.querySelectorAll('.ob-disable'); }
  function sendBtn() { return document.getElementById('ob-send-btn'); }
  form.addEventListener('submit', function (e) {
    if (form.dataset.busy) { e.preventDefault(); return; }
    form.dataset.busy = '1';
    setTimeout(function () {
      var els = controls();
      for (var i = 0; i < els.length; i += 1) els[i].setAttribute('disabled', '');
      var b = sendBtn();
      if (b) b.innerHTML = '<span class="spinner"></span>\\u00a0Sending\\u2026';
      if (statusEl) {
        statusEl.textContent = 'Sending\\u2026';
        timers.push(setTimeout(function () {
          statusEl.textContent = 'The mail service is busy \\u2014 retrying\\u2026';
        }, 4000));
        timers.push(setTimeout(function () {
          statusEl.textContent = 'Still working\\u2026';
        }, 12000));
      }
    }, 0);
  });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    delete form.dataset.busy;
    for (var i = 0; i < timers.length; i += 1) clearTimeout(timers[i]);
    timers = [];
    var els = controls();
    for (var j = 0; j < els.length; j += 1) els[j].removeAttribute('disabled');
    var b = sendBtn();
    if (b) b.textContent = b.dataset.label || 'Send';
    if (statusEl) statusEl.textContent = '';
  });
}());</script>`;

function chrome(inner: string): string {
  return `<style>${OUTBOX_CSS}</style><div class="ob">${inner}</div>`;
}

function sendForm(confirmPath: string, label: string): string {
  return `<form id="ob-send" method="POST" action="${esc(confirmPath)}">
    <button id="ob-send-btn" type="submit" class="btn primary ob-btn ob-disable" data-label="${esc(label)}">${esc(label)}</button>
  </form>
  <div id="ob-status" class="ob-status" role="status" aria-live="polite"></div>`;
}

function detailBlock(summary: string): string {
  return `<details class="ob-detail"><summary>Technical details</summary><pre>${esc(summary)}</pre></details>`;
}

function recipientBlock(row: OutboxRow): string {
  const cc = row.cc.length
    ? `<div class="ob-to-list">Cc: ${esc(row.cc.join(', '))}</div>`
    : '';
  return `<div>
    <div class="ob-to-label">To</div>
    <div class="ob-to-name">${esc(row.recipientDisplay)}</div>
    ${row.to.length > 1 ? `<div class="ob-to-list">${esc(row.to.join(', '))}</div>` : ''}
    ${cc}
  </div>`;
}

export function reviewPage(
  row: OutboxRow,
  p: { confirmPath: string; cancelPath: string },
): string {
  const body =
    chrome(`
  ${recipientBlock(row)}
  ${row.subject ? `<div class="ob-subject">${esc(row.subject)}</div>` : ''}
  <pre class="ob-body">${esc(row.bodyMarkdown)}</pre>
  <div class="ob-actions">
    ${sendForm(p.confirmPath, 'Confirm & send')}
    <form method="POST" action="${esc(p.cancelPath)}"><button type="submit" class="btn ob-btn-secondary ob-disable">Cancel</button></form>
  </div>`) + CONFIRM_SCRIPT;
  return renderShell(css(), {
    title: 'Review and send',
    variant: 'minimal',
    body,
  });
}

export function linkPage(row: OutboxRow, p: { confirmPath: string }): string {
  const body =
    chrome(`
  ${recipientBlock(row)}
  <div class="ob-actions">${sendForm(p.confirmPath, 'Send')}</div>`) +
    CONFIRM_SCRIPT;
  return renderShell(css(), {
    title: 'Send message?',
    variant: 'minimal',
    body,
  });
}

export function failedPage(
  row: OutboxRow,
  p: { shaped: ShapedOutboundError; confirmPath: string },
): string {
  // kind 'unknown' means shapeOutboundError could not prove the send was
  // ever rejected — its own message already says the send "MAY still have
  // been sent — check your Sent folder". A headline of 'Not sent' plus
  // "create a new draft" contradicts that outright, so this kind alone gets
  // its own title and non-retryable note. Every other non-retryable kind
  // ('unsupported') IS certain the send never went out, so 'Not sent' and
  // the plain "create a new draft" note stay correct for it.
  const uncertain = p.shaped.kind === 'unknown';
  const retry = p.shaped.canRetry
    ? `<div class="ob-actions">${sendForm(p.confirmPath, 'Try again')}</div>`
    : `<p class="ob-note">${
        uncertain
          ? "If it's not in your Sent folder, ask your assistant to create a new draft."
          : 'Ask your assistant to create a new draft.'
      }</p>`;
  const body =
    chrome(`
  ${ICON_SVGS[p.shaped.canRetry ? 'warn' : 'error']}
  <p class="ob-msg">${esc(p.shaped.message)}</p>
  <div class="ob-to-list">To ${esc(row.recipientDisplay)}</div>
  ${retry}
  ${detailBlock(p.shaped.summary)}`) +
    (p.shaped.canRetry ? CONFIRM_SCRIPT : '');
  return renderShell(css(), {
    title: uncertain ? 'Delivery uncertain' : 'Not sent',
    variant: 'minimal',
    body,
  });
}

export function resultPage(
  title: string,
  message: string,
  opts?: { icon?: OutboxIcon; detail?: string; footNote?: string },
): string {
  const body = chrome(`
  ${opts?.icon ? ICON_SVGS[opts.icon] : ''}
  <p class="ob-msg">${esc(message)}</p>
  ${opts?.footNote ? `<p class="ob-note">${esc(opts.footNote)}</p>` : ''}
  ${opts?.detail ? detailBlock(opts.detail) : ''}`);
  return renderShell(css(), { title, variant: 'minimal', body });
}
