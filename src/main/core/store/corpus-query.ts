import type { Account, Query } from '@shared/contracts';

import type { AppDb, AppDbParam } from '../../db/app-db';
import { stemVariants } from '../stemming';
import { ftsQuery } from './fts-query';
import {
  buildSnippet,
  extractTerms,
  foldForNegation,
  rrfMerge,
  toTrigramMatch,
} from './fuzzy';
import { toAccount, toDocument, type AccountRow, type DocRow } from './rows';

/** Walks the docs_languages index (schema.ts), not the documents table. */
export const CORPUS_LANGUAGES_SQL = `SELECT DISTINCT languages FROM documents`;

/** Metadata paths scanned by the `participant:` filter — extend as new
 *  connector metadata shapes appear (slack/whatsapp senders etc.). */
const PARTICIPANT_METADATA_PATHS = [
  '$.from',
  '$.to',
  '$.cc',
  '$.participants',
  '$.sender',
  '$.author',
] as const;

/** The read surface, in one place: the read worker's allow-list, the proxy and
 *  the fallback wrapper all derive from this list. */
export const QUERY_METHODS = [
  'document',
  'documentPage',
  'children',
  'byExternalId',
  'search',
  'count',
  'countBy',
  'accounts',
] as const;
export type QueryMethod = (typeof QUERY_METHODS)[number];

export interface CorpusQueryOptions {
  /** `'explicit'` (default, the writer): the distinct-languages cache is
   *  dropped by `invalidateLanguages()` — the writer's own commits do not
   *  change its `PRAGMA data_version`. `'data-version'` (readers, the stdio
   *  sibling): the cache is keyed by `PRAGMA data_version`, sampled on the same
   *  connection BEFORE the lookup that fills it. */
  languageCache?: 'explicit' | 'data-version';
}

export interface CorpusQuery {
  query: Query;
  /** Drops the languages cache (explicit mode; harmless in data-version mode). */
  invalidateLanguages(): void;
}

export async function accountsFrom(reader: AppDb): Promise<Account[]> {
  const rows = (await reader.all(
    `SELECT * FROM accounts ORDER BY created_at`,
  )) as unknown as AccountRow[];
  return rows.map(toAccount);
}

export function createCorpusQuery(
  db: AppDb,
  opts: CorpusQueryOptions = {},
): CorpusQuery {
  const mode = opts.languageCache ?? 'explicit';
  let cache: { langs: string[]; version: number | null } | null = null;

  const loadLanguages = async (): Promise<string[]> => {
    const rows = (await db.all(CORPUS_LANGUAGES_SQL)) as unknown as Array<{
      languages: string;
    }>;
    const set = new Set<string>(['eng']);
    for (const r of rows)
      for (const l of JSON.parse(r.languages) as string[]) set.add(l);
    return [...set];
  };

  const corpusLanguages = async (): Promise<string[]> => {
    if (mode === 'explicit') {
      if (!cache) cache = { langs: await loadLanguages(), version: null };
      return cache.langs;
    }
    // data-version: sample BEFORE the lookup and store it with the result, so
    // a commit landing mid-fill makes the NEXT call see a different version.
    const rows = (await db.all(`PRAGMA data_version`)) as unknown as Array<{
      data_version: number;
    }>;
    const version = rows[0].data_version;
    if (cache && cache.version === version) return cache.langs;
    const langs = await loadLanguages();
    cache = { langs, version };
    return langs;
  };

  const findDocRow = async (
    accountId: string,
    externalId: string,
    type: string,
  ): Promise<DocRow | undefined> => {
    const rows = await db.all(
      `SELECT * FROM documents WHERE account_id = ? AND external_id = ? AND type = ?`,
      [accountId, externalId, type],
    );
    return rows[0] as unknown as DocRow | undefined;
  };

  const query: Query = {
    async document(id) {
      const r = (
        await db.all(`SELECT * FROM documents WHERE id = ?`, [id])
      )[0] as unknown as DocRow | undefined;
      return r ? toDocument(r) : null;
    },
    async documentPage(input) {
      const limit = Math.max(0, Math.min(100, Math.floor(input.limit)));
      if (limit === 0 || input.types.length === 0) return [];
      const placeholders = input.types.map(() => '?').join(',');
      const params: AppDbParam[] = [...input.types];
      let after = '';
      if (input.afterId) {
        after = ' AND id > ?';
        params.push(input.afterId);
      }
      params.push(limit);
      const rows = (await db.all(
        `SELECT * FROM documents WHERE archived_at IS NULL AND type IN (${placeholders})${after} ORDER BY id LIMIT ?`,
        params,
      )) as unknown as DocRow[];
      return rows.map(toDocument);
    },
    async children(id) {
      const rows = (await db.all(
        `SELECT * FROM documents WHERE parent_id = ? AND archived_at IS NULL
           ORDER BY created_at`,
        [id],
      )) as unknown as DocRow[];
      return rows.map(toDocument);
    },
    async byExternalId(account, externalId, type) {
      const r = await findDocRow(account, externalId, type);
      return r ? toDocument(r) : null;
    },
    async search(q) {
      const limit = Math.min(q.limit ?? 50, 500);
      const offset = q.offset ?? 0;
      const filters: string[] = [];
      const params: AppDbParam[] = [];
      if (!q.includeArchived) filters.push(`d.archived_at IS NULL`);
      if (q.type) {
        filters.push(`d.type = ?`);
        params.push(q.type);
      }
      if (q.account) {
        filters.push(`d.account_id = ?`);
        params.push(q.account);
      }
      // Bounds apply to the document's ORIGIN date (when the email/message
      // was written), falling back to ingest time for undated documents —
      // never to write order, which a newest-first backfill inverts.
      if (q.fromDate) {
        filters.push(`COALESCE(d.created_at, d.ingested_at) >= ?`);
        params.push(q.fromDate);
      }
      if (q.toDate) {
        filters.push(`COALESCE(d.created_at, d.ingested_at) <= ?`);
        params.push(q.toDate);
      }
      // Structured metadata filters (spec 2026-08-08): all json_extract over
      // documents.metadata, appended to the SAME filters/params arrays so
      // they apply to the FTS pass, the trigram fallback, and the recency
      // path alike. Substring matches are lower()-folded — ASCII-only, a
      // documented v1 limitation.
      const likeEsc = (v: string) =>
        `%${v.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const jsonLower = (p: string) =>
        `lower(COALESCE(json_extract(d.metadata,'${p}'),''))`;
      const orLike = (expr: string, values: string[]) => {
        filters.push(
          `(${values.map(() => `${expr} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
        );
        for (const v of values) params.push(likeEsc(v));
      };
      if (q.people?.from?.length) orLike(jsonLower('$.from'), q.people.from);
      if (q.people?.to?.length) orLike(jsonLower('$.to'), q.people.to);
      if (q.people?.participant?.length) {
        const haystack =
          PARTICIPANT_METADATA_PATHS.map(jsonLower).join(` || char(10) || `);
        orLike(`(${haystack})`, q.people.participant);
      }
      if (q.label?.length) {
        // Quoted-token match inside the JSON array text: label:in must not
        // match "INBOX".
        filters.push(
          `(${q.label
            .map(() => `${jsonLower('$.labels')} LIKE ? ESCAPE '\\'`)
            .join(' OR ')})`,
        );
        for (const v of q.label)
          params.push(
            `%"${v.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}"%`,
          );
      }
      if (q.hasAttachment) {
        filters.push(
          `EXISTS (SELECT 1 FROM documents c WHERE c.parent_id = d.id
             AND c.type = 'attachment' AND c.archived_at IS NULL)`,
        );
      }
      if (q.filename?.length) orLike(jsonLower('$.filename'), q.filename);
      if (q.ext?.length) {
        // Only local-folder docs write metadata.ext; gmail attachments only
        // have filename/mime (spec follow-up, 2026-08-08 review round 2).
        // Each value matches EITHER the exact ext field OR a filename
        // suffix, so `ext:pdf in:gmail` can find attachments too.
        filters.push(
          `(${q.ext
            .map(
              () =>
                `(${jsonLower('$.ext')} = ? OR ${jsonLower(
                  '$.filename',
                )} LIKE ? ESCAPE '\\')`,
            )
            .join(' OR ')})`,
        );
        for (const raw of q.ext) {
          const v = raw.toLowerCase().replace(/^\./, '');
          params.push(v);
          params.push(`%.${v.replace(/[\\%_]/g, (c) => `\\${c}`)}`);
        }
      }
      const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
      if (q.text?.trim()) {
        const langs = await corpusLanguages();
        const orderSql =
          q.orderBy === 'newest'
            ? `ORDER BY COALESCE(d.created_at, d.ingested_at) DESC, d.id DESC`
            : `ORDER BY bm25(documents_fts, 0, 4.0, 1.0, 2.0, 0.5)`;
        const rows = (await db.all(
          `SELECT d.*, snippet(documents_fts, 2, '<b>', '</b>', '…', 24) AS _snippet
             FROM documents_fts f JOIN documents d ON d.id = f.doc_id
             WHERE documents_fts MATCH ? ${where}
             ${orderSql}
             LIMIT ? OFFSET ?`,
          [
            ftsQuery(q.text, (term) => stemVariants(term, langs)),
            ...params,
            limit,
            offset,
          ],
        )) as unknown as Array<DocRow & { _snippet: string }>;

        // Fuzzy fallback (trigram substring recall + RRF, spec 2026-07-11):
        // only when the exact+stemmed pass left the FIRST page short — good
        // queries never pay for a second index scan, near-misses (compound
        // words, truncations) get rescued.
        if (offset === 0 && rows.length < limit) {
          const { positive, negated } = extractTerms(q.text);
          // Cannot-represent-it ⇒ don't-fuzz: (a) every positive term must
          // survive into the trigram AND group — a silently dropped <3-char
          // term would smuggle partial matches past the implicit-AND
          // grammar; (b) grouped negation (NOT (a b)) has no flat-term
          // representation, so its exclusions can't be re-applied to fuzzy
          // hits. Such queries get no fuzzy pass.
          const triMatch =
            positive.every((t) => t.length >= 3) && !/\bNOT\s*\(/.test(q.text)
              ? toTrigramMatch(positive)
              : null;
          if (triMatch) {
            const triRows = (await db.all(
              `SELECT d.* FROM documents_tri t JOIN documents d ON d.id = t.doc_id
                 WHERE documents_tri MATCH ? ${where}
                 ORDER BY bm25(documents_tri) LIMIT ?`,
              [triMatch, ...params, limit],
            )) as unknown as DocRow[];
            // A NOT-excluded document must never resurface via fuzzy: drop
            // hits containing any negated term (substring match, Unicode
            // lowercase — deliberately broader than FTS token semantics).
            // Both sides are folded the same way the primary index folds
            // tokens (NFKC, ё→е, lowercase, diacritics stripped), so this
            // filter can never be WEAKER than the grammar's own negation
            // (e.g. -uber must still drop a hit containing über).
            const negatedFolded = negated.map((n) => foldForNegation(n));
            const safe = triRows.filter((r) => {
              const haystack = foldForNegation(
                `${r.title ?? ''}\n${r.markdown ?? ''}`,
              );
              return !negatedFolded.some((n) => haystack.includes(n));
            });
            const snippets = new Map(rows.map((r) => [r.id, r._snippet]));
            // Fuzzy may only FILL the page's remaining slots, never displace
            // an exact match: rows already in the primary list pass through
            // (they merge, adding rank signal without growing the union),
            // new rows are capped to the free slots.
            const seen = new Set(rows.map((r) => r.id));
            let free = limit - rows.length;
            const capped: DocRow[] = [];
            for (const r of safe) {
              if (seen.has(r.id)) capped.push(r);
              else if (free > 0) {
                capped.push(r);
                free -= 1;
              }
            }
            const fused = rrfMerge<DocRow>(rows, capped, (r) => r.id, limit);
            if (q.orderBy === 'newest') {
              const dateOf = (r: DocRow) => r.created_at ?? r.ingested_at;
              fused.sort((a, b) =>
                dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0,
              );
            }
            return fused.map((r) => ({
              ...toDocument(r),
              snippet:
                snippets.get(r.id) ?? buildSnippet(r.markdown ?? '', positive),
            }));
          }
        }
        return rows.map((r) => ({ ...toDocument(r), snippet: r._snippet }));
      }
      const rows = (await db.all(
        `SELECT d.* FROM documents d WHERE 1=1 ${where}
           ORDER BY COALESCE(d.created_at, d.ingested_at) DESC, d.id DESC
           LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )) as unknown as DocRow[];
      return rows.map(toDocument);
    },
    async count(q) {
      const filters: string[] = [];
      const params: AppDbParam[] = [];
      if (!q.includeArchived) filters.push(`archived_at IS NULL`);
      if (q.type) {
        filters.push(`type = ?`);
        params.push(q.type);
      }
      if (q.account) {
        filters.push(`account_id = ?`);
        params.push(q.account);
      }
      if (q.fromDate) {
        filters.push(`COALESCE(created_at, ingested_at) >= ?`);
        params.push(q.fromDate);
      }
      if (q.toDate) {
        filters.push(`COALESCE(created_at, ingested_at) <= ?`);
        params.push(q.toDate);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const r = (
        await db.all(`SELECT COUNT(*) AS c FROM documents ${where}`, params)
      )[0] as { c: number };
      return r.c;
    },
    async countBy(q) {
      const filters = [`1=1`];
      const params: AppDbParam[] = [];
      if (!q.includeArchived) filters.push(`d.archived_at IS NULL`);
      if (q.type) {
        filters.push(`d.type = ?`);
        params.push(q.type);
      }
      if (q.account) {
        filters.push(`d.account_id = ?`);
        params.push(q.account);
      }
      if (q.fromDate) {
        filters.push(`COALESCE(d.created_at, d.ingested_at) >= ?`);
        params.push(q.fromDate);
      }
      if (q.toDate) {
        filters.push(`COALESCE(d.created_at, d.ingested_at) <= ?`);
        params.push(q.toDate);
      }
      const where = filters.join(' AND ');
      const sql =
        q.field === 'from'
          ? `SELECT COALESCE(json_extract(d.metadata,'$.from'),'(none)') AS key,
                    COUNT(*) AS count
               FROM documents d WHERE ${where}
               GROUP BY key ORDER BY count DESC, key LIMIT 100`
          : `SELECT je.value AS key, COUNT(*) AS count
               FROM documents d,
                    json_each(COALESCE(json_extract(d.metadata,'$.labels'),'[]')) je
               WHERE ${where}
               GROUP BY je.value ORDER BY count DESC, key LIMIT 100`;
      return (await db.all(sql, params)) as Array<{
        key: string;
        count: number;
      }>;
    },
    async accounts() {
      return accountsFrom(db);
    },
  };

  return {
    query,
    invalidateLanguages: () => {
      cache = null;
    },
  };
}
