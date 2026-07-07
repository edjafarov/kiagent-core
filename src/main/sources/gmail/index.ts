/**
 * Gmail Source — pull-based port of legacy kiagent-ref's gmail connector.
 * See gmail-source.ts / oauth.ts for design notes.
 */
export { gmailSource } from './gmail-source';
export { googleOAuthProfile, googleRefresher, GMAIL_SCOPES } from './oauth';
export type { GmailCursor } from './cursor';
export type { GmailThreadItem } from './to-document';
