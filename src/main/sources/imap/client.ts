import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type {
  ImapAccountConfig,
  ImapClient,
  ImapFolderInfo,
  ImapMailboxStatus,
  ImapRawMessage,
} from './types';

/** Pure mapping from our config to imapflow connection options (unit-tested). */
export function toImapFlowOptions(
  config: ImapAccountConfig,
  password: string,
): ImapFlowOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: password },
    logger: false,
    // Defensive timeouts so a wedged/unresponsive server can't tie up a
    // pull() indefinitely.
    greetingTimeout: 15000,
    // imapflow's socketTimeout fires on socket *inactivity*. Kept generous
    // (matches the legacy connector) since parsing + reply-stripping happens
    // between fetches with no socket traffic.
    socketTimeout: 300000,
  };
}

/**
 * Attach an 'error' listener so an asynchronous socket failure can't crash
 * the process — imapflow's ImapFlow is an EventEmitter, and Node THROWS any
 * emitted 'error' that has zero listeners. With a listener attached the event
 * is merely logged; any pending operation still rejects and is handled by the
 * caller's own try/catch. Exported for unit testing.
 */
export function attachImapErrorHandler(
  flow: { on(event: 'error', listener: (err: unknown) => void): unknown },
  log: (...args: unknown[]) => void = console.error,
): void {
  flow.on('error', (err) => {
    const e = err as { message?: string; code?: string } | undefined;
    log('[imap] client error', e?.code ?? '', e?.message ?? String(err));
  });
}

/**
 * Build a connected ImapClient backed by imapflow. The caller owns the
 * lifecycle and MUST call close().
 */
export async function connectImapClient(
  config: ImapAccountConfig,
  password: string,
): Promise<ImapClient> {
  const flow = new ImapFlow(toImapFlowOptions(config, password));
  // Attached BEFORE connect() so a failure during/after connect can't escape
  // as an uncaughtException.
  attachImapErrorHandler(flow);
  await flow.connect();

  return {
    async listFolders(): Promise<ImapFolderInfo[]> {
      const list = await flow.list();
      return list.map((m) => ({
        path: m.path,
        specialUse: m.specialUse,
        flags: [...m.flags].map((f) => String(f).toLowerCase()),
      }));
    },

    async status(path: string): Promise<ImapMailboxStatus> {
      const lock = await flow.getMailboxLock(path);
      try {
        const mb = flow.mailbox;
        if (!mb) throw new Error(`imap: could not open mailbox ${path}`);
        return {
          uidValidity: Number(mb.uidValidity),
          uidNext: Number(mb.uidNext),
          exists: mb.exists,
        };
      } finally {
        lock.release();
      }
    },

    async listUids(path: string): Promise<number[]> {
      const lock = await flow.getMailboxLock(path);
      try {
        const uids = await flow.search({ all: true }, { uid: true });
        return Array.isArray(uids) ? uids.map(Number) : [];
      } finally {
        lock.release();
      }
    },

    async fetchMany(path: string, uids: number[]): Promise<ImapRawMessage[]> {
      if (uids.length === 0) return [];
      const lock = await flow.getMailboxLock(path);
      try {
        const out: ImapRawMessage[] = [];
        // {uid:true} makes the sequence set a UID set, not message numbers.
        for await (const msg of flow.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
          if (msg.source) out.push({ uid: msg.uid, source: msg.source });
        }
        return out;
      } finally {
        lock.release();
      }
    },

    async close(): Promise<void> {
      await flow.logout().catch(() => flow.close());
    },
  };
}
