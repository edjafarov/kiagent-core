import type {
  Account,
  AccountId,
  Document,
  DocumentId,
  SyncStatus,
} from '@shared/contracts';

export interface DocRow {
  id: string;
  account_id: string;
  external_id: string;
  type: string;
  title: string | null;
  markdown: string | null;
  url: string | null;
  metadata: string;
  created_at: string | null;
  parent_id: string | null;
  content_hash: string;
  seq: number;
  /** v7. `undefined` on a pre-v7 database, like scope_root_id below. */
  ingest_seq: number;
  archived_at: string | null;
  languages: string;
  ingested_at: string;
  updated_at: string;
  /** v3. `undefined` on a pre-v3 database — every read site is `SELECT *`,
   *  so `toDocument`'s `?? null` absorbs the absence. */
  scope_root_id: string | null;
}

export interface AccountRow {
  id: string;
  source: string;
  identifier: string;
  config: string;
  status: string;
  cursor: string | null;
  progress: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  cadence: string | null;
  created_at: string;
}

export function toDocument(r: DocRow): Document {
  return {
    id: r.id as DocumentId,
    accountId: r.account_id as AccountId,
    externalId: r.external_id,
    type: r.type,
    title: r.title,
    markdown: r.markdown,
    url: r.url ?? undefined,
    metadata: JSON.parse(r.metadata),
    createdAt: r.created_at,
    parentId: (r.parent_id as DocumentId) ?? null,
    contentHash: r.content_hash,
    seq: r.seq,
    ingestSeq: r.ingest_seq ?? 0,
    archivedAt: r.archived_at,
    languages: JSON.parse(r.languages),
    ingestedAt: r.ingested_at,
    updatedAt: r.updated_at,
    scopeRootId: r.scope_root_id ?? null,
  };
}

export function toAccount(r: AccountRow): Account {
  return {
    id: r.id as AccountId,
    source: r.source,
    identifier: r.identifier,
    config: JSON.parse(r.config),
    status: r.status as SyncStatus,
    cursor: r.cursor === null ? null : JSON.parse(r.cursor),
    progress: r.progress === null ? undefined : JSON.parse(r.progress),
    lastSyncAt: r.last_sync_at ?? undefined,
    lastError: r.last_error ?? undefined,
    cadence: r.cadence === null ? undefined : JSON.parse(r.cadence),
    createdAt: r.created_at,
  };
}
