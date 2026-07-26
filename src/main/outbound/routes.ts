/**
 * /outbox/* routes for the loopback MCP HTTP server. GET only renders; every
 * mutation is a POST carrying the signed token in its PATH (spec §5:
 * unfurlers/prefetchers GET links the moment they render — GET must never
 * send). The server's checkLoopbackRequest guard has already vetted
 * Host/Origin before this module runs.
 */
import type http from 'http';

import type { OutboxRow } from '@shared/contracts';

import { linkPage, resultPage, reviewPage } from './pages';
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

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sentWhen(row: OutboxRow): string {
  return row.sentAt ? ` (${row.sentAt})` : '';
}

function gonePage(row: OutboxRow): string {
  if (row.status === 'sent')
    return resultPage(
      'Already sent',
      `This message to ${row.recipientDisplay} was already sent${sentWhen(row)}.`,
    );
  if (row.status === 'discarded')
    return resultPage('Cancelled', 'This draft was cancelled.');
  if (row.status === 'failed')
    return resultPage(
      'Send failed',
      `${row.error ?? 'Unknown error'} — ask your assistant to create a new draft.`,
    );
  if (row.status === 'delivery_unknown')
    return resultPage(
      'Delivery uncertain',
      'The app closed while this message was being sent — it MAY have gone ' +
        'out. Check your Sent folder before creating a new draft.',
    );
  if (row.status === 'expired')
    return resultPage(
      'Draft expired',
      'Ask your assistant to create the draft again.',
    );
  return resultPage('In progress', 'This draft is being sent.');
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
  );
}

export function createOutboundRoutes(outbound: OutboundService): {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean>;
} {
  return {
    async handle(req, res, url) {
      const confirm = /^\/outbox\/confirm\/([^/]+)$/.exec(url.pathname);
      const cancel = /^\/outbox\/cancel\/([^/]+)$/.exec(url.pathname);

      if (confirm && req.method === 'GET') {
        try {
          const peek = await outbound.peekByToken(confirm[1]);
          if (peek.kind === 'invalid') sendHtml(res, 404, invalidPage());
          else if (peek.kind === 'gone') sendHtml(res, 200, gonePage(peek.row));
          else {
            const confirmPath = `/outbox/confirm/${confirm[1]}`;
            const cancelPath = `/outbox/cancel/${confirm[1]}`;
            sendHtml(
              res,
              200,
              peek.mode === 'review'
                ? reviewPage(peek.row, { confirmPath, cancelPath })
                : linkPage(peek.row, { confirmPath }),
            );
          }
        } catch {
          sendHtml(
            res,
            500,
            resultPage(
              'Something went wrong',
              'This link could not be opened right now. Nothing was sent — try again in a moment.',
            ),
          );
        }
        return true;
      }

      if (confirm && req.method === 'POST') {
        try {
          const out = await outbound.confirmByToken(confirm[1]);
          if (out.kind === 'invalid') sendHtml(res, 404, invalidPage());
          else if (out.kind === 'sent')
            sendHtml(
              res,
              200,
              resultPage(
                'Message sent',
                `Sent to ${out.row.recipientDisplay}${sentWhen(out.row)}.`,
              ),
            );
          else if (out.kind === 'failed') sendHtml(res, 200, gonePage(out.row));
          else sendHtml(res, 200, gonePage(out.row));
        } catch {
          // A throw here can only come from POST-send bookkeeping (the
          // service's own comment: sender.send() already resolved before
          // this could throw) — the message may already be on the wire, so
          // this must NEVER read as "failed to send". Honest unknown-state
          // copy only; the boot-time sweep will classify the row itself.
          sendHtml(
            res,
            500,
            resultPage(
              'Status unknown',
              'Something went wrong after this was submitted. It may have ' +
                'already been sent — check your Sent folder before asking ' +
                'for a new draft.',
            ),
          );
        }
        return true;
      }

      if (cancel && req.method === 'POST') {
        try {
          const out = await outbound.cancelByToken(cancel[1]);
          if (out.kind === 'invalid') sendHtml(res, 404, invalidPage());
          else if (out.kind === 'cancelled')
            sendHtml(
              res,
              200,
              resultPage('Cancelled', 'This draft was cancelled.'),
            );
          else sendHtml(res, 200, gonePage(out.row));
        } catch {
          sendHtml(
            res,
            500,
            resultPage(
              'Status unknown',
              'Something went wrong while cancelling. Check list_outbox for this draft’s current status.',
            ),
          );
        }
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
          sendJson(res, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      return false;
    },
  };
}
