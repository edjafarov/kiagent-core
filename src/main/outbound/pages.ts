/**
 * Outbox confirm-surface HTML (spec §5) — variant 'minimal' pages rendered
 * from the FROZEN outbox row: what the user reviews here is exactly what the
 * app will send, no matter what a prompt-injected session claimed in chat.
 * The recipient line is the load-bearing element on every page.
 */
import { createHash } from 'crypto';
import { esc, renderShell } from '@shared/web-ui';
import { loadShellCss } from '@shared/web-ui/loader-node';
import type { ShellCss } from '@shared/web-ui/render-shell';
import type { OutboxRow } from '@shared/contracts';
import { defaultSendLater } from '@shared/send-presets';

import { originOf } from './service';

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

// Corners stay SQUARE (tokens.css: "Radius — SHARP throughout") — no
// border-radius anywhere here. Layout-only overrides of the shared shell.
const OUTBOX_CSS = `
.ob { display: flex; flex-direction: column; gap: 14px; }
.sh-min__card { max-width: 520px; width: 100%; }
.ob-to-label { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.08em; }
.ob-to-name { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; color: var(--text-primary); }
.ob-to-list { font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.ob-mirror { font-size: 12px; color: var(--text-secondary); }
.ob-attachments { list-style: none; margin: 0; padding: 0; font-size: 13px; color: var(--text-primary); }
.ob-attachments li { overflow-wrap: anywhere; }
.ob-attachments span { color: var(--text-secondary); }
.ob-subject { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.ob-body { white-space: pre-wrap; font-family: inherit; font-size: 14px; line-height: 1.55;
  color: var(--text-primary); background: var(--bg-muted);
  border: 1px solid var(--border-subtle);
  padding: 12px 14px; max-height: 50vh; overflow: auto; margin: 0; }
.ob-body.ob-mail { white-space: normal; background: #ffffff; color: #1e293b;
  overflow-wrap: anywhere; }
.ob-mail a { color: #4f46e5; }
.ob-mail th, .ob-mail td { border: 1px solid #e2e8f0; padding: 4px 8px; }
.ob-mail table { border-collapse: collapse; }
.ob-actions { display: flex; flex-direction: column; gap: 10px;
  position: sticky; bottom: 0; background: var(--bg-canvas); padding: 10px 0 2px; }
.ob-actions form { margin: 0; }
.ob-btn { height: 48px; width: 100%; font-size: 15px; }
.ob-btn-secondary { height: 44px; width: 100%; font-size: 14px; }
.ob-later > summary { list-style: none; display: flex; align-items: center;
  justify-content: center; cursor: pointer; }
.ob-later > summary::-webkit-details-marker { display: none; }
.ob-later-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.ob-later-list .btn { height: 40px; width: 100%; font-size: 14px;
  display: flex; justify-content: space-between; }
.ob-later-list .btn span { color: var(--text-secondary); }
.ob-custom { display: flex; gap: 6px; }
.ob-custom input { flex: 1; min-width: 0; height: 40px; font: inherit; font-size: 14px;
  padding: 0 8px; border: 1px solid var(--border-subtle); background: var(--bg-canvas);
  color: var(--text-primary); }
.ob-custom .btn { width: auto; flex: none; justify-content: center; }
.ob-status { min-height: 20px; display: flex; gap: 8px; align-items: center;
  justify-content: center; font-size: 13px; color: var(--text-secondary); }
.ob-icon { width: 44px; height: 44px; }
.ob-msg { font-size: 14px; line-height: 1.6; color: var(--text-primary); margin: 0; }
.ob-note { font-size: 13px; color: var(--text-secondary); margin: 0; }
.ob-detail { font-size: 12px; color: var(--text-secondary); }
.ob-detail summary { cursor: pointer; }
.ob-detail pre { white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--font-mono); font-size: 11px; background: var(--bg-muted);
  border: 1px solid var(--border-subtle);
  padding: 8px 10px; margin: 6px 0 0; }
@media (max-width: 480px) {
  .sh-min { align-items: flex-start; padding-top: 36px; }
}
`;

// Stroke hexes mirror tokens.css status colors (--live-solid,
// --working-solid, --error-solid, --paused-solid) — inline SVG attributes
// can't read CSS custom properties when the shell CSS fails to load, and
// keeping the literal values means the unstyled fallback page still gets
// correctly-colored icons. Update both places if the palette ever moves.
const ICON_SVGS: Record<OutboxIcon, string> = {
  success: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#0d9488" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m8.2 12.4 2.6 2.6 5-5.4"/></svg>`,
  warn: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#c2410c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 21.5 20h-19L12 3.5Z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/></svg>`,
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
const CONFIRM_JS = `(function () {
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
  var custom = document.getElementById('ob-custom');
  if (custom) custom.addEventListener('submit', function () {
    var at = custom.elements.namedItem('at');
    var ms = custom.elements.namedItem('ms');
    var t = at && at.value ? new Date(at.value).getTime() : NaN;
    if (ms) ms.value = isFinite(t) ? String(t) : '';
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
}());`;
const CONFIRM_SCRIPT = `<script>${CONFIRM_JS}</script>`;

/** The outbox pages' Content-Security-Policy: no script but the page's own
 *  (by hash), no remote images, forms post only back here — a draft body
 *  that slipped past the renderer still could not run or phone home. */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${createHash('sha256').update(CONFIRM_JS).digest('base64')}'`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src data:',
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

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
  const bcc = row.bcc.length
    ? `<div class="ob-to-list ob-bcc">Bcc: ${esc(row.bcc.join(', '))}</div>`
    : '';
  return `<div>
    <div class="ob-to-label">To</div>
    <div class="ob-to-name">${esc(row.recipientDisplay)}</div>
    ${row.to.length > 1 ? `<div class="ob-to-list">${esc(row.to.join(', '))}</div>` : ''}
    ${cc}
    ${bcc}
  </div>`;
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Every file that goes with the message: name, size, where it came from. */
function attachmentList(row: OutboxRow): string {
  if (!row.attachments.length) return '';
  const items = row.attachments
    .map(
      (a) =>
        `<li>${esc(a.filename)} <span>· ${esc(sizeText(a.size))} · ${esc(originOf(a, row.mirror?.provider))}</span></li>`,
    )
    .join('');
  return `<ul class="ob-attachments" aria-label="Attachments">${items}</ul>`;
}

/** Where the draft lives besides Kia: "In Gmail Drafts", or why not. */
export function mirrorNote(row: OutboxRow): string | null {
  const m = row.mirror;
  if (!m) return null;
  if (m.ref)
    return m.provider ? `In ${m.provider} Drafts` : "In your mail app's Drafts";
  return m.error ? `Not synced: ${m.error}` : null;
}

/** A draft scheduled in the app (read-only here): when it goes. Its note
 *  otherwise ("Missed its time — …", "Edited — schedule again"). */
export function scheduleNote(row: OutboxRow, timeZone?: string): string | null {
  if (row.status !== 'draft') return null;
  if (row.sendAt) {
    const when = new Date(row.sendAt).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      // The page may open on a phone in another zone: say whose time.
      timeZoneName: 'short',
      ...(timeZone ? { timeZone } : {}),
    });
    return `Scheduled for ${when} — Send here sends it now`;
  }
  return row.error;
}

/** Send later on the link page (spec 2026-10-21 §5.3): the app's presets,
 *  then a time of the user's own. Folded until asked for. */
function laterBlock(
  later: NonNullable<Parameters<typeof reviewPage>[1]['later']>,
  scheduled: boolean,
): string {
  const presets = later.presets
    .map(
      (x) =>
        `<form method="POST" action="${esc(x.path)}"><button type="submit" class="btn ob-disable">${esc(x.label)} <span>${esc(x.when)}</span></button></form>`,
    )
    .join('');
  return `<details class="ob-later">
    <summary class="btn ob-btn-secondary">${scheduled ? 'Change time' : 'Send later'} ▾</summary>
    <div class="ob-later-list">
      ${presets}
      <form id="ob-custom" class="ob-custom" method="POST" action="${esc(later.customPath)}">
        <input type="datetime-local" name="at" required value="${esc(defaultSendLater(Date.now()))}" aria-label="Send at">
        <input type="hidden" name="ms" value="">
        <button type="submit" class="btn primary ob-disable">Schedule</button>
      </form>
    </div>
  </details>`;
}

/** The one confirm page for every mode (spec §4.3). `confirmPath` carries
 *  the revision shown here; `changed` = a Send from an older page landed
 *  here instead (HTTP 409). */
export function reviewPage(
  row: OutboxRow,
  p: {
    confirmPath: string;
    cancelPath: string;
    /** A scheduled draft: its "Cancel schedule" (the draft stays). */
    unschedulePath?: string;
    changed?: boolean;
    /** An email's body as it will be sent (core's rendering, safe). */
    bodyHtml?: string;
    /** The AI app's suggested time, still ahead: one click schedules it. */
    suggestion?: { path: string; label: string };
    /** Send later: the app's Send ▾ presets and a custom time. */
    later?: {
      presets: { path: string; label: string; when: string }[];
      customPath: string;
    };
  },
): string {
  const body =
    chrome(`
  ${p.changed ? `<p class="ob-note ob-changed">This draft changed — review it again. Nothing was sent.</p>` : ''}
  ${recipientBlock(row)}
  ${mirrorNote(row) ? `<div class="ob-mirror">${esc(mirrorNote(row)!)}</div>` : ''}
  ${scheduleNote(row) ? `<div class="ob-mirror">${esc(scheduleNote(row)!)}</div>` : ''}
  ${row.subject ? `<div class="ob-subject">${esc(row.subject)}</div>` : ''}
  ${
    p.bodyHtml !== undefined
      ? `<div class="ob-body ob-mail">${p.bodyHtml}</div>`
      : `<pre class="ob-body">${esc(row.bodyMarkdown)}</pre>`
  }
  ${attachmentList(row)}
  <span class="ob-rev" hidden>${row.revision}</span>
  <div class="ob-actions">
    ${
      p.suggestion
        ? `<form method="POST" action="${esc(p.suggestion.path)}"><button type="submit" class="btn primary ob-btn ob-disable">${esc(p.suggestion.label)}</button></form>`
        : ''
    }
    ${sendForm(p.confirmPath, p.suggestion || p.unschedulePath ? 'Send now' : 'Confirm & send')}
    ${p.later ? laterBlock(p.later, Boolean(p.unschedulePath)) : ''}
    ${
      p.unschedulePath
        ? `<form method="POST" action="${esc(p.unschedulePath)}"><button type="submit" class="btn ob-btn-secondary ob-disable">Cancel schedule</button></form>`
        : `<form method="POST" action="${esc(p.cancelPath)}"><button type="submit" class="btn ob-btn-secondary ob-disable">Cancel</button></form>`
    }
  </div>`) + CONFIRM_SCRIPT;
  return renderShell(css(), {
    title: 'Review and send',
    variant: 'minimal',
    wordmark: 'kia',
    body,
  });
}

export function failedPage(
  row: OutboxRow,
  p: { shaped: ShapedOutboundError; reopenPath: string },
): string {
  // kind 'unknown' means shapeOutboundError could not prove the send was
  // ever rejected — its own message already says the send "MAY still have
  // been sent — check your Sent folder". A headline of 'Not sent' plus
  // "create a new draft" contradicts that outright, so this kind alone gets
  // its own title, non-retryable note, and the amber warn icon (matching
  // the delivery_unknown status page, which frames the same uncertainty).
  // Every other non-retryable kind ('unsupported') IS certain the send
  // never went out, so 'Not sent', the plain "create a new draft" note,
  // and the red error icon stay correct for it.
  const uncertain = p.shaped.kind === 'unknown';
  const retry = p.shaped.canRetry
    ? `<div class="ob-actions"><form method="POST" action="${esc(p.reopenPath)}"><button type="submit" class="btn primary ob-btn">Review again</button></form></div>`
    : `<p class="ob-note">${
        uncertain
          ? "If it's not in your Sent folder, ask your assistant to create a new draft."
          : 'Ask your assistant to create a new draft.'
      }</p>`;
  const body = chrome(`
  ${ICON_SVGS[p.shaped.canRetry || uncertain ? 'warn' : 'error']}
  <p class="ob-msg">${esc(p.shaped.message)}</p>
  <div class="ob-to-list">To ${esc(row.recipientDisplay)}</div>
  ${retry}
  ${detailBlock(p.shaped.summary)}`);
  return renderShell(css(), {
    title: uncertain ? 'Delivery uncertain' : 'Not sent',
    variant: 'minimal',
    wordmark: 'kia',
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
  return renderShell(css(), {
    title,
    variant: 'minimal',
    wordmark: 'kia',
    body,
  });
}
