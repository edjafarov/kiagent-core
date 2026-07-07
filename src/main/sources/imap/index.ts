/** Public surface of the IMAP source, for src/main/sources/index.ts to wire up. */
export { createImapSource } from './source';
export type { ImapSourceDeps, ConnectFn, SleepFn } from './source';
export type {
  ImapAccountConfig,
  ImapClient,
  ImapCursor,
  ImapMessageItem,
  ImapFolderInfo,
  ImapMailboxStatus,
  ImapRawMessage,
  ResolvedMailbox,
  MailboxRole,
  FolderCursorEntry,
} from './types';
