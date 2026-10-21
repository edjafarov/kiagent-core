/**
 * /outbox/* routes for the loopback MCP HTTP server. GET only renders; every
 * mutation is a POST carrying the signed token in its PATH (spec §5:
 * unfurlers/prefetchers GET links the moment they render — GET must never
 * send). The server's checkLoopbackRequest guard has already vetted
 * Host/Origin before this module runs.
 */
import type http from 'http';

import type { OutboxRow } from '@shared/contracts';

import { sendPresets, whenLabel } from '@shared/send-presets';
import { logMessageOf } from '../core/mcp/log-safe';
import { shapeOutboundError } from './error-copy';
import { isOutboundToolOp } from './ops';
import { failedPage, PAGE_CSP, resultPage, reviewPage } from './pages';
import type { OutboundService } from './service';

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
): void {
  // These pages carry draft content (recipient/subject/body) under a
  // token-bearing URL — keep them out of any disk/shared cache and never
  // leak the URL (hence the token) via a Referer header to a link the page
  // itself might contain.
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': PAGE_CSP,
  });
  res.end(html);
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

// 64 KB is plenty for the op protocol's largest legitimate payload (a
// draft's subject + body). Past that, this is either a misbehaving client or
// an attempt to make the loopback server buffer an unbounded amount of
// memory per request — reject it instead of accumulating chunks forever.
const MAX_JSON_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {
  constructor(max = MAX_JSON_BODY_BYTES) {
    super(`request body exceeds ${max} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return readBody(req, MAX_JSON_BODY_BYTES).then((text) =>
    text ? JSON.parse(text) : null,
  );
}

// The link page's custom-time form: two short fields.
const MAX_FORM_BODY_BYTES = 1024;

/** A request body as text, at most `max` bytes. Its listeners attach
 *  synchronously (see `matchOutboxPage`). */
function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > max) {
        settled = true;
        // Stop retaining chunks (bounds memory) and reject so the caller can
        // send its 413 — but do NOT destroy the request/socket here: an
        // IncomingMessage.destroy() tears down the underlying socket, and
        // doing that before the response has been written would race the
        // 413 itself and can surface to the client as a connection reset
        // instead of a clean JSON error. The caller destroys the connection
        // (if it wants to) only after res.end() has gone out.
        reject(new BodyTooLargeError(max));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

function sentWhen(row: OutboxRow): string {
  if (!row.sentAt) return '';
  // Human-readable, in the machine's locale + timezone — the server IS the
  // user's own computer, so its clock is the right frame of reference.
  const d = new Date(row.sentAt);
  if (Number.isNaN(d.getTime())) return ` (${row.sentAt})`;
  const when = d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return ` (${when})`;
}

function gonePage(row: OutboxRow, token: string): string {
  if (row.status === 'sent')
    return resultPage(
      'Already sent',
      `This message to ${row.recipientDisplay} was already sent${sentWhen(row)}.`,
      { icon: 'success' },
    );
  if (row.status === 'discarded')
    return resultPage('Cancelled', 'This draft was cancelled.', {
      icon: 'info',
    });
  if (row.status === 'failed')
    return failedPage(row, {
      shaped: shapeOutboundError(row.error ?? ''),
      reopenPath: `/outbox/reopen/${token}`,
    });
  if (row.status === 'delivery_unknown')
    return resultPage(
      'Delivery uncertain',
      // A mirrored draft that left the mail app's Drafts says so itself.
      row.error?.startsWith('No longer in Drafts')
        ? `${row.error}.`
        : 'The app closed while this message was being sent — it MAY have gone ' +
            'out. Check your Sent folder before creating a new draft.',
      { icon: 'warn' },
    );
  if (row.status === 'expired')
    return resultPage(
      'Draft expired',
      'Ask your assistant to create the draft again.',
      { icon: 'info' },
    );
  return resultPage('In progress', 'This draft is being sent.', {
    icon: 'info',
  });
}

// Lazy, not module-level: `resultPage` reads shell CSS off disk via
// loadShellCss (@shared/web-ui/loader-node), and this module is imported
// unconditionally by server.ts. A CSS-loading failure must surface as a
// 404-time error inside `handle()`, never as an import-time throw that would
// take startMcp down before a single /outbox/* request is ever served.
function invalidPage(): string {
  return resultPage(
    'Link invalid or expired',
    'Ask your assistant to run list_outbox for a fresh confirmation link.',
    { icon: 'error' },
  );
}

type PageResult = { status: number; html: string };

// Shared per-path handlers (Task 2): both `handle` (loopback) and
// `handleRemote` (remote HTTPS tunnel) dispatch into these so the
// pages/outcomes/status codes stay byte-identical across transports —
// the only difference between the two entry points is which paths are
// allowlisted and how the request URL gets parsed.
/** One review page for every confirm mode (spec §4.3), bound to the row's
 *  revision: its Send posts to /outbox/confirm/<token>/<revision>. */
async function reviewFor(
  outbound: OutboundService,
  row: OutboxRow,
  token: string,
  changed = false,
): Promise<string> {
  const at = row.suggestedSendAt ? Date.parse(row.suggestedSendAt) : NaN;
  const ahead = !row.sendAt && at > Date.now() + 60_000;
  return reviewPage(row, {
    confirmPath: `/outbox/confirm/${token}/${row.revision}`,
    cancelPath: `/outbox/cancel/${token}`,
    ...(row.sendAt && {
      unschedulePath: `/outbox/unschedule/${token}/${row.revision}`,
    }),
    changed,
    bodyHtml: await outbound.bodyHtmlFor(row),
    later: {
      presets: sendPresets(Date.now()).map((x) => ({
        path: `/outbox/schedule/${token}/${row.revision}/${x.key}`,
        label: x.label,
        when: whenLabel(x.at, Date.now()),
      })),
      customPath: `/outbox/schedule/${token}/${row.revision}`,
    },
    ...(ahead && {
      suggestion: {
        path: `/outbox/schedule/${token}/${row.revision}/${at}`,
        label: `Schedule for ${timeText(row.suggestedSendAt!)}`,
      },
    }),
  });
}

/** "Thu 22 Oct, 14:12 CEST" — the zone named: the page may open elsewhere. */
function timeText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

/** The link page's "Cancel schedule": the draft stays (spec 2026-10-21 §5.3). */
async function postUnschedule(
  outbound: OutboundService,
  token: string,
  revision: number,
): Promise<PageResult> {
  try {
    const out = await outbound.unscheduleByToken(token, revision);
    if (out.kind === 'invalid') return { status: 404, html: invalidPage() };
    if (out.kind === 'changed')
      return {
        status: 409,
        html: await reviewFor(outbound, out.row, token, true),
      };
    if (out.kind === 'unscheduled')
      return {
        status: 200,
        html: resultPage(
          'Schedule cancelled',
          `The message to ${out.row.recipientDisplay} stays a draft — nothing will be sent until you send it.`,
          { icon: 'info', footNote: 'You can close this page.' },
        ),
      };
    return { status: 200, html: gonePage(out.row, token) };
  } catch {
    return {
      status: 500,
      html: resultPage(
        'Something went wrong',
        'The schedule could not be cancelled right now — try again in a moment.',
        { icon: 'warn' },
      ),
    };
  }
}

/** The time a schedule POST names: the AI's suggestion (epoch ms in the
 *  path), a Send later preset (its key — counted from now, not from when
 *  the page opened) or the custom form (`ms` from the page's script, else
 *  `at` as this computer's local time). NaN = none. */
async function scheduleTime(
  req: http.IncomingMessage,
  when: string | undefined,
): Promise<number> {
  if (when !== undefined) {
    if (/^\d+$/.test(when)) return Number(when);
    return sendPresets(Date.now()).find((x) => x.key === when)?.at ?? NaN;
  }
  const form = new URLSearchParams(await readBody(req, MAX_FORM_BODY_BYTES));
  const ms = form.get('ms') ?? '';
  if (/^\d+$/.test(ms)) return Number(ms);
  const at = form.get('at') ?? '';
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at) ? Date.parse(at) : NaN;
}

/** The link page's "Schedule for …" and Send later (spec 2026-10-21 §5.3). */
async function postSchedule(
  outbound: OutboundService,
  req: http.IncomingMessage,
  token: string,
  revision: number,
  when: string | undefined,
): Promise<PageResult> {
  try {
    const atMs = await scheduleTime(req, when);
    if (!Number.isFinite(atMs))
      return {
        status: 400,
        html: resultPage(
          'Not scheduled',
          'That time is not available any more — open the link again and pick another.',
          { icon: 'warn', footNote: 'Nothing was sent.' },
        ),
      };
    const out = await outbound.scheduleByToken(token, revision, atMs);
    if (out.kind === 'invalid') return { status: 404, html: invalidPage() };
    if (out.kind === 'changed')
      return {
        status: 409,
        html: await reviewFor(outbound, out.row, token, true),
      };
    if (out.kind === 'scheduled')
      return {
        status: 200,
        html: resultPage(
          'Scheduled',
          `It goes to ${out.row.recipientDisplay} on ${timeText(out.row.sendAt!)}, as it is now — any change cancels the schedule.`,
          { icon: 'success', footNote: 'You can close this page.' },
        ),
      };
    if (out.kind === 'failed')
      return {
        status: 503,
        html: resultPage(
          'Not scheduled',
          out.error.replace(/^not scheduled:\s*/, ''),
          { icon: 'warn', footNote: 'Nothing was sent.' },
        ),
      };
    return { status: 200, html: gonePage(out.row, token) };
  } catch {
    return {
      status: 500,
      html: resultPage(
        'Something went wrong',
        'This could not be scheduled right now. Nothing was sent — try again in a moment.',
        { icon: 'warn' },
      ),
    };
  }
}

async function peekPage(
  outbound: OutboundService,
  peek: Awaited<ReturnType<OutboundService['peekByToken']>>,
  token: string,
): Promise<PageResult> {
  if (peek.kind === 'invalid') return { status: 404, html: invalidPage() };
  if (peek.kind === 'gone')
    return { status: 200, html: gonePage(peek.row, token) };
  return { status: 200, html: await reviewFor(outbound, peek.row, token) };
}

async function getConfirm(
  outbound: OutboundService,
  token: string,
): Promise<PageResult> {
  try {
    return await peekPage(outbound, await outbound.peekByToken(token), token);
  } catch {
    return {
      status: 500,
      html: resultPage(
        'Something went wrong',
        'This link could not be opened right now. Nothing was sent — try again in a moment.',
        { icon: 'warn' },
      ),
    };
  }
}

async function postConfirm(
  outbound: OutboundService,
  token: string,
  revision: number | null,
): Promise<PageResult> {
  try {
    const out = await outbound.confirmByToken(token, revision);
    if (out.kind === 'invalid') return { status: 404, html: invalidPage() };
    // 409: the confirmed page showed another revision (or an old page
    // carried none). The current one is shown; nothing was sent.
    if (out.kind === 'changed')
      return {
        status: 409,
        html: await reviewFor(outbound, out.row, token, true),
      };
    if (out.kind === 'sent')
      return {
        status: 200,
        html: resultPage(
          'Message sent',
          `Sent to ${out.row.recipientDisplay}${sentWhen(out.row)}.`,
          { icon: 'success', footNote: 'You can close this page.' },
        ),
      };
    if (out.kind === 'failed' && out.row.status === 'draft')
      return {
        status: 503,
        html: resultPage('Not sent', shapeOutboundError(out.error).message, {
          icon: 'warn',
          footNote: 'Reload this page to send it again.',
        }),
      };
    return { status: 200, html: gonePage(out.row, token) };
  } catch {
    return {
      status: 500,
      html: resultPage(
        'Status unknown',
        'Something went wrong after this was submitted. It may have ' +
          'already been sent — check your Sent folder before asking ' +
          'for a new draft.',
        { icon: 'warn' },
      ),
    };
  }
}

/** The failed page's "Review again": reopen, then the review page. */
async function postReopen(
  outbound: OutboundService,
  token: string,
): Promise<PageResult> {
  try {
    return await peekPage(outbound, await outbound.reopenByToken(token), token);
  } catch {
    return {
      status: 500,
      html: resultPage(
        'Something went wrong',
        'This draft could not be reopened right now. Nothing was sent — try again in a moment.',
        { icon: 'warn' },
      ),
    };
  }
}

async function postCancel(
  outbound: OutboundService,
  token: string,
): Promise<PageResult> {
  try {
    const out = await outbound.cancelByToken(token);
    if (out.kind === 'invalid') return { status: 404, html: invalidPage() };
    if (out.kind === 'cancelled')
      return {
        status: 200,
        html: resultPage('Cancelled', 'This draft was cancelled.', {
          icon: 'info',
        }),
      };
    return { status: 200, html: gonePage(out.row, token) };
  } catch {
    return {
      status: 500,
      html: resultPage(
        'Status unknown',
        'Something went wrong while cancelling. Check list_outbox for this draft’s current status.',
        { icon: 'warn' },
      ),
    };
  }
}

type OutboxMatch =
  | { kind: 'get-confirm'; token: string }
  | { kind: 'post-confirm'; token: string; revision: number | null }
  | { kind: 'post-reopen'; token: string }
  | { kind: 'post-cancel'; token: string }
  | {
      kind: 'post-schedule';
      token: string;
      revision: number;
      /** Epoch ms or a preset key; none = the custom form's body. */
      when: string | undefined;
    }
  | { kind: 'post-unschedule'; token: string; revision: number };

// Routing decision for the THREE token-gated confirm/cancel routes shared by
// both transports — deliberately a PLAIN (non-async) function. `handle` must
// stay synchronous right up to the point it actually starts one of the
// per-path handlers below, because the /outbox/api branch's readJsonBody
// attaches its 'data' listener synchronously too (the 64 KB-cap unit test
// emits chunks on a bare EventEmitter immediately after calling handle(),
// with no listener-attachment delay tolerated) — routing this match through
// so much as one `await` would push that attach past a microtask tick and
// silently drop that test's emitted chunks. Returns null for anything else
// (notably `/outbox/api`, which only `handle` — the loopback entry point —
// serves) so each caller decides what a non-match means (loopback falls
// through to the JSON dispatcher; remote just 404s).
function matchOutboxPage(
  method: string | undefined,
  pathname: string,
): OutboxMatch | null {
  // The revision segment rides only on the page's Send; a GET ignores it.
  const confirm = /^\/outbox\/confirm\/([^/]+)(?:\/(\d+))?$/.exec(pathname);
  if (confirm && method === 'GET')
    return { kind: 'get-confirm', token: confirm[1] };
  if (confirm && method === 'POST')
    return {
      kind: 'post-confirm',
      token: confirm[1],
      revision: confirm[2] === undefined ? null : Number(confirm[2]),
    };

  const reopen = /^\/outbox\/reopen\/([^/]+)$/.exec(pathname);
  if (reopen && method === 'POST')
    return { kind: 'post-reopen', token: reopen[1] };

  const cancel = /^\/outbox\/cancel\/([^/]+)$/.exec(pathname);
  if (cancel && method === 'POST')
    return { kind: 'post-cancel', token: cancel[1] };

  const schedule =
    /^\/outbox\/schedule\/([^/]+)\/(\d+)(?:\/(\d+|[a-z][a-z0-9-]*))?$/.exec(
      pathname,
    );
  if (schedule && method === 'POST')
    return {
      kind: 'post-schedule',
      token: schedule[1],
      revision: Number(schedule[2]),
      when: schedule[3],
    };

  const unschedule = /^\/outbox\/unschedule\/([^/]+)\/(\d+)$/.exec(pathname);
  if (unschedule && method === 'POST')
    return {
      kind: 'post-unschedule',
      token: unschedule[1],
      revision: Number(unschedule[2]),
    };

  return null;
}

function runOutboxMatch(
  outbound: OutboundService,
  match: OutboxMatch,
  req: http.IncomingMessage,
): Promise<PageResult> {
  if (match.kind === 'get-confirm') return getConfirm(outbound, match.token);
  if (match.kind === 'post-confirm')
    return postConfirm(outbound, match.token, match.revision);
  if (match.kind === 'post-reopen') return postReopen(outbound, match.token);
  if (match.kind === 'post-schedule')
    return postSchedule(outbound, req, match.token, match.revision, match.when);
  if (match.kind === 'post-unschedule')
    return postUnschedule(outbound, match.token, match.revision);
  return postCancel(outbound, match.token);
}

export function createOutboundRoutes(outbound: OutboundService): {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean>;
  /** Remote-transport entry: serves ONLY GET/POST /outbox/confirm/<token>
   *  (POST with /<revision>), POST /outbox/reopen/<token>, POST
   *  /outbox/cancel/<token> and POST /outbox/{schedule,unschedule}/<token>/
   *  <revision>[/<time or preset>]. Everything else under /outbox/ —
   *  including /outbox/api — returns false (caller 404s). No Host/Origin
   *  loopback check: the remote server has real TLS Host semantics and the
   *  pages are HMAC-token-gated. Parses the path itself since the remote
   *  Router hands over a raw request with no pre-parsed URL. */
  handleRemote(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean>;
} {
  return {
    async handle(req, res, url) {
      const match = matchOutboxPage(req.method, url.pathname);
      if (match) {
        const page = await runOutboxMatch(outbound, match, req);
        sendHtml(res, page.status, page.html);
        return true;
      }

      if (url.pathname === '/outbox/api' && req.method === 'POST') {
        try {
          const body = (await readJsonBody(req)) as {
            op?: string;
            args?: Record<string, unknown>;
          } | null;
          const op = body?.op;
          const args = body?.args;
          // Screened against the SHARED op list (ops.ts) before dispatch, so
          // the "unknown op" reply and the set this plane actually serves
          // cannot disagree with the client's idea of it.
          if (!isOutboundToolOp(op)) {
            sendJson(res, { ok: false, error: `unknown op '${op}'` });
          } else if (op === 'ping') {
            sendJson(res, { ok: true, result: { pong: 'kiagent-outbox' } });
          } else if (op === 'draftReply') {
            sendJson(res, {
              ok: true,
              result: await outbound.draftReply(
                args as Parameters<OutboundService['draftReply']>[0],
              ),
            });
          } else if (op === 'draftMessage') {
            sendJson(res, {
              ok: true,
              result: await outbound.draftMessage(
                args as Parameters<OutboundService['draftMessage']>[0],
              ),
            });
          } else if (op === 'listOutbox') {
            sendJson(res, {
              ok: true,
              // Its arg is the one all-optional payload on the interface —
              // a payload-less call must still reach it as {}.
              result: await outbound.listOutbox(
                (args ?? {}) as Parameters<OutboundService['listOutbox']>[0],
              ),
            });
          } else if (op === 'sendDraft') {
            sendJson(res, {
              ok: true,
              result: await outbound.sendDraft(
                args as Parameters<OutboundService['sendDraft']>[0],
              ),
            });
          } else if (op === 'reviseDraft') {
            sendJson(res, {
              ok: true,
              result: await outbound.reviseDraft(
                args as unknown as Parameters<
                  OutboundService['reviseDraft']
                >[0],
              ),
            });
          } else if (op === 'scheduleDrafts') {
            sendJson(res, {
              ok: true,
              result: await outbound.scheduleDrafts(
                args as Parameters<OutboundService['scheduleDrafts']>[0],
              ),
            });
          } else {
            // Unreachable — `op` is `never` here, and that is the point:
            // adding an op to OUTBOUND_TOOL_OPS without a branch above is a
            // compile error on this line, not a runtime "unknown op".
            const unhandled: never = op;
            sendJson(res, { ok: false, error: `unknown op '${unhandled}'` });
          }
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, { ok: false, error: err.message }, 413);
            // Safe only now: the 413 response has already been written, so
            // tearing down the connection can't race it.
            req.destroy();
          } else {
            const error = err instanceof Error ? err.message : String(err);
            const logMessage = logMessageOf(err);
            sendJson(res, {
              ok: false,
              error,
              ...(logMessage !== error ? { logMessage } : {}),
            });
          }
        }
        return true;
      }

      return false;
    },

    async handleRemote(req, res) {
      const url = new URL(req.url ?? '/', 'http://x');
      const match = matchOutboxPage(req.method, url.pathname);
      if (!match) return false;
      const page = await runOutboxMatch(outbound, match, req);
      sendHtml(res, page.status, page.html);
      return true;
    },
  };
}
