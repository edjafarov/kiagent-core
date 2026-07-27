/**
 * /outbox/* routes for the loopback MCP HTTP server. GET only renders; every
 * mutation is a POST carrying the signed token in its PATH (spec §5:
 * unfurlers/prefetchers GET links the moment they render — GET must never
 * send). The server's checkLoopbackRequest guard has already vetted
 * Host/Origin before this module runs.
 */
import type http from 'http';

import type { OutboxRow } from '@shared/contracts';

import { shapeOutboundError } from './error-copy';
import { failedPage, linkPage, resultPage, reviewPage } from './pages';
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
  constructor() {
    super(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_JSON_BODY_BYTES) {
        settled = true;
        // Stop retaining chunks (bounds memory) and reject so the caller can
        // send its 413 — but do NOT destroy the request/socket here: an
        // IncomingMessage.destroy() tears down the underlying socket, and
        // doing that before the response has been written would race the
        // 413 itself and can surface to the client as a connection reset
        // instead of a clean JSON error. The caller destroys the connection
        // (if it wants to) only after res.end() has gone out.
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : null);
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

function gonePage(row: OutboxRow, confirmPath: string): string {
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
      confirmPath,
    });
  if (row.status === 'delivery_unknown')
    return resultPage(
      'Delivery uncertain',
      'The app closed while this message was being sent — it MAY have gone ' +
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
async function getConfirm(
  outbound: OutboundService,
  token: string,
): Promise<PageResult> {
  const confirmPath = `/outbox/confirm/${token}`;
  try {
    const peek = await outbound.peekByToken(token);
    if (peek.kind === 'invalid') return { status: 404, html: invalidPage() };
    if (peek.kind === 'gone')
      return { status: 200, html: gonePage(peek.row, confirmPath) };
    const cancelPath = `/outbox/cancel/${token}`;
    return {
      status: 200,
      html:
        peek.mode === 'review'
          ? reviewPage(peek.row, { confirmPath, cancelPath })
          : linkPage(peek.row, { confirmPath }),
    };
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
): Promise<PageResult> {
  const confirmPath = `/outbox/confirm/${token}`;
  try {
    const out = await outbound.confirmByToken(token);
    if (out.kind === 'invalid') return { status: 404, html: invalidPage() };
    if (out.kind === 'sent')
      return {
        status: 200,
        html: resultPage(
          'Message sent',
          `Sent to ${out.row.recipientDisplay}${sentWhen(out.row)}.`,
          { icon: 'success', footNote: 'You can close this page.' },
        ),
      };
    // 'failed' and 'already' (a raced/reused link) both render the same
    // terminal page as any other non-draft row.
    return { status: 200, html: gonePage(out.row, confirmPath) };
  } catch {
    // This catch can't tell a pre-send throw (secret(), expireOverdue,
    // outbox.get — nothing sent yet) apart from a post-send bookkeeping
    // throw (sender.send() already resolved — the message may be on the
    // wire per confirmByToken's own comment). Since both land here
    // indistinguishably, the copy below stays conservative for BOTH cases
    // rather than risk ever reading "failed to send" for a message that
    // actually went out. Honest unknown-state copy only; the boot-time
    // sweep classifies the row itself for the post-send case.
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

async function postCancel(
  outbound: OutboundService,
  token: string,
): Promise<PageResult> {
  const confirmPath = `/outbox/confirm/${token}`;
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
    return { status: 200, html: gonePage(out.row, confirmPath) };
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
  | { kind: 'post-confirm'; token: string }
  | { kind: 'post-cancel'; token: string };

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
  const confirm = /^\/outbox\/confirm\/([^/]+)$/.exec(pathname);
  if (confirm && method === 'GET')
    return { kind: 'get-confirm', token: confirm[1] };
  if (confirm && method === 'POST')
    return { kind: 'post-confirm', token: confirm[1] };

  const cancel = /^\/outbox\/cancel\/([^/]+)$/.exec(pathname);
  if (cancel && method === 'POST')
    return { kind: 'post-cancel', token: cancel[1] };

  return null;
}

function runOutboxMatch(
  outbound: OutboundService,
  match: OutboxMatch,
): Promise<PageResult> {
  if (match.kind === 'get-confirm') return getConfirm(outbound, match.token);
  if (match.kind === 'post-confirm') return postConfirm(outbound, match.token);
  return postCancel(outbound, match.token);
}

export function createOutboundRoutes(outbound: OutboundService): {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean>;
  /** Remote-transport entry: serves ONLY GET/POST /outbox/confirm/<token>
   *  and POST /outbox/cancel/<token>. Everything else under /outbox/ —
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
        const page = await runOutboxMatch(outbound, match);
        sendHtml(res, page.status, page.html);
        return true;
      }

      if (url.pathname === '/outbox/api' && req.method === 'POST') {
        try {
          const body = (await readJsonBody(req)) as {
            op?: string;
            args?: Record<string, unknown>;
          } | null;
          if (body?.op === 'ping') {
            sendJson(res, { ok: true, result: { pong: 'kiagent-outbox' } });
          } else if (body?.op === 'draftReply') {
            sendJson(res, {
              ok: true,
              result: await outbound.draftReply(
                body.args as Parameters<OutboundService['draftReply']>[0],
              ),
            });
          } else if (body?.op === 'draftMessage') {
            sendJson(res, {
              ok: true,
              result: await outbound.draftMessage(
                body.args as Parameters<OutboundService['draftMessage']>[0],
              ),
            });
          } else if (body?.op === 'listOutbox') {
            sendJson(res, {
              ok: true,
              result: await outbound.listOutbox(
                (body.args ?? {}) as Parameters<
                  OutboundService['listOutbox']
                >[0],
              ),
            });
          } else {
            sendJson(res, { ok: false, error: `unknown op '${body?.op}'` });
          }
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            sendJson(res, { ok: false, error: err.message }, 413);
            // Safe only now: the 413 response has already been written, so
            // tearing down the connection can't race it.
            req.destroy();
          } else {
            sendJson(res, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
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
      const page = await runOutboxMatch(outbound, match);
      sendHtml(res, page.status, page.html);
      return true;
    },
  };
}
