import type { Query, QueryAccount } from '@shared/contracts';

type SourceLookup = {
  get(id: string): { descriptor: { documentTypes: string[] } } | undefined;
};

/** The extension-facing query: every account names the document types its
 *  source produces, so an extension finds e.g. calendar accounts by TYPE
 *  (then queries each account: the documents index leads with account). A
 *  source that is not registered right now yields []. */
export function withAccountTypes(query: Query, sources: SourceLookup): Query {
  return {
    ...query,
    accounts: async (): Promise<QueryAccount[]> =>
      (await query.accounts()).map((a) => ({
        ...a,
        documentTypes: sources.get(a.source)?.descriptor.documentTypes ?? [],
      })),
  };
}
