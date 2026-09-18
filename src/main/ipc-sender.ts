import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SENDER_VALIDATED_CHANNELS = new Set([
  'attention:list',
  'attention:act',
]);

export function guardIpcHandler<Req, Res>(
  channel: string,
  handler: (request: Req) => Res,
  isTrustedSender: (event: unknown) => boolean,
): (event: unknown, request: Req) => Res {
  return (event, request) => {
    if (SENDER_VALIDATED_CHANNELS.has(channel) && !isTrustedSender(event))
      throw new Error('untrusted renderer');
    return handler(request);
  };
}

export interface BrowserWindowLike {
  isDestroyed(): boolean;
  webContents: { getURL(): string; mainFrame?: unknown };
}

export function expectedRendererUrl(app: {
  isPackaged?: boolean;
  getAppPath(): string;
}): string {
  if (process.env.NODE_ENV === 'development') {
    return new URL(`http://localhost:${process.env.PORT || '1212'}/index.html`)
      .href;
  }
  return pathToFileURL(
    path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'),
  ).href;
}

export function createTrustedRendererPredicate(deps: {
  app: { isPackaged?: boolean; getAppPath(): string };
  BrowserWindow: { getAllWindows(): BrowserWindowLike[] };
}): (event: unknown) => boolean {
  return (event: unknown): boolean => {
    const e = event as {
      sender?: BrowserWindowLike['webContents'];
      senderFrame?: unknown;
    };
    if (!e.sender || !e.senderFrame) return false;
    const expected = expectedRendererUrl(deps.app);
    const matches = deps.BrowserWindow.getAllWindows().filter((win) => {
      if (win.isDestroyed()) return false;
      return win.webContents.getURL() === expected;
    });
    if (matches.length !== 1) return false;
    const sender = matches[0].webContents;
    return e.sender === sender && e.senderFrame === sender.mainFrame;
  };
}
