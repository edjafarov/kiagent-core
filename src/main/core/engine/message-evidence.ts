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
  signal: AbortSignal;
}

export async function readMessageEvidence(
  deps: MessageEvidenceDeps,
  input: MessageEvidenceReadInput,
): Promise<MessageEvidenceReadResult> {
  if (
    !input ||
    !Array.isArray(input.authors) ||
    typeof input.expectedContentHash !== 'string' ||
    typeof input.documentId !== 'string' ||
    input.authors.some((author) => typeof author !== 'string')
  )
    return { status: 'unavailable', messages: [] };
  if (input.authors.length > 8 || deps.signal.aborted)
    return { status: 'unavailable', messages: [] };
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
      deps.session(account, deps.signal, 'message-evidence'),
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
  if (
    !Array.isArray(messages) ||
    messages.some((message) => !validMessageEvidence(message))
  )
    return { status: 'unavailable', messages: [] };
  if (deps.signal.aborted) return { status: 'stale', messages: [] };
  return { status: 'ok', messages: messages.slice(0, 3) };
}

function validMessageEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.version === 1 &&
    typeof message.messageKey === 'string' &&
    typeof message.author === 'string' &&
    (message.at === null || typeof message.at === 'string') &&
    (message.signature === null ||
      (typeof message.signature === 'string' &&
        message.signature.length <= 1200)) &&
    typeof message.excerpt === 'string' &&
    message.excerpt.length <= 800 &&
    typeof message.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(message.fingerprint)
  );
}
