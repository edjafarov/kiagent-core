import type {
  Account,
  AccountId,
  MessageEvidenceReadInput,
  MessageEvidenceReadResult,
  Session,
  Source,
} from '@shared/contracts';
import type { CoreStore } from '../store/store';

export interface MessageEvidenceDeps {
  store: CoreStore;
  sources: { get(id: string): Source | undefined };
  session(account: Account, signal: AbortSignal, scope: string): Session;
  paused(accountId: AccountId): boolean;
  transitioning(accountId: AccountId): boolean;
}

export async function readMessageEvidence(
  deps: MessageEvidenceDeps,
  input: MessageEvidenceReadInput,
): Promise<MessageEvidenceReadResult> {
  if (input.authors.length > 8)
    throw new RangeError('message evidence supports at most 8 authors');
  const doc = await deps.store.read.document(input.documentId);
  if (!doc || doc.archivedAt) return { status: 'unavailable', messages: [] };
  if (doc.contentHash !== input.expectedContentHash)
    return { status: 'stale', messages: [] };
  const account = await deps.store.account(doc.accountId);
  if (!account || ['paused', 'needsReauth', 'error'].includes(account.status))
    return { status: 'unavailable', messages: [] };
  if (deps.paused(account.id) || deps.transitioning(account.id))
    return { status: 'unavailable', messages: [] };
  const source = deps.sources.get(account.source);
  if (!source?.readMessageEvidence)
    return { status: 'unsupported', messages: [] };
  let messages;
  try {
    messages = await source.readMessageEvidence(
      deps.session(account, new AbortController().signal, 'message-evidence'),
      doc,
      { authors: input.authors, limit: 3 },
    );
  } catch {
    return { status: 'unavailable', messages: [] };
  }
  const freshDoc = await deps.store.read.document(input.documentId);
  const freshAccount = await deps.store.account(doc.accountId);
  if (
    !freshDoc ||
    freshDoc.archivedAt ||
    freshDoc.contentHash !== input.expectedContentHash ||
    !freshAccount ||
    ['paused', 'needsReauth', 'error'].includes(freshAccount.status) ||
    deps.paused(account.id) ||
    deps.transitioning(account.id)
  )
    return { status: 'stale', messages: [] };
  return { status: 'ok', messages: messages.slice(0, 3) };
}
