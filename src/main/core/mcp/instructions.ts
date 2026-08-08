/**
 * Server instructions advertised in the MCP `initialize` handshake — guidance
 * the calling LLM reads before its first tool call, so it materially shapes
 * how clients drive the tools. Ported from kiagent-ref's
 * src/main/mcp/instructions.ts, ADAPTED to the greenfield tool surface:
 *  - `query_sql`/`get_schema` patterns dropped (not exposed — see tools/).
 *  - Search is FTS5 unicode61 (diacritics-folded) with stemming applied via
 *    `stemVariants` on every term, so the text tells the model when stemming
 *    won't help (brand names, codes) and to vary word forms there.
 *  - Thread dating updated: a greenfield gmail thread's `created_at` IS the
 *    latest message's date (metadata key `lastMessageAt`, camelCase) — the
 *    legacy "old created_at but still active" caveat no longer applies.
 *  - `get_related` exposes `children`/`parent` (one relation each way).
 *  - NEW (not in ref): a "point back to the original" block — nothing else
 *    tells the model that `source_url` exists or that the user wants it.
 */
export const KIA_INSTRUCTIONS = `"Kia" is the nickname users use for this MCP server (kiagent).
When a user addresses you as "kia" or mentions kia in a request,
they are asking you to use these tools to answer.

Kia gives access to an indexed personal/team digital memory —
emails, files, meeting notes, attachments, chats. Use it for any
question about something the user has read, written, sent, received,
saved, or been involved in.

Full-text search: bare terms are ANDed; "quoted phrases" match
exactly; -term excludes; UPPERCASE OR alternates; term* prefix-
matches; parentheses group. Terms are stemmed — "invoice" matches
"invoices"; use term* or OR-of-variants only when a stem might miss
(brand names, codes). The digital memory is multilingual — if a
search returns nothing, retry in the likely source language. Call
digital_memory_info to see what languages are present.

Operators (gmail-style, inside the query string):
  from: / to: / participant: — people, case-insensitive substring
    on name or address: from:sebastian, from:@zoolatech.com,
    from:"Roman Kaplun"
  label:inbox   has:attachment   filename:report   ext:pdf
  in:gmail (alias source:)   type:email.thread
  order:newest | order:relevance (default: relevance with text,
    newest without)
Repeat an operator to OR within it (from:a from:b); different
operators AND. Operators-only queries list matching docs newest
first. Example: from:@zoolatech.com has:attachment order:newest

Recency & dates. The digital memory can span many years and holds
outdated, superseded material. Every date — created_at and the
from_date / to_date filters — is when the item was sent, received,
or created at the source, never when Kia indexed it. Unless the
user explicitly asks about the past, treat the newest matching
document as current and older ones as superseded; when several
documents answer the same factual question, prefer the most recent
and give its date. For an open-ended "what's the current..."
question, bias to recent — e.g. restrict to about the last 90 days
with from_date, and widen only if the answer isn't there. State any
window you applied.

Email threads carry their LATEST message's date as created_at (also
metadata.lastMessageAt), so recency ordering reflects activity.
Expand a thread's individual messages — or any document's
attachments — with get_related(children).

Common patterns:
  find / what about X      → search
  recent X / lately        → search + from_date
  what's in your memory    → digital_memory_info
  how many docs per source → count
  who sent what / per-sender or per-label counts
                            → count group_by:'from'|'label'
  latest from a person     → search "from:x order:newest"
  full doc body            → search → get
  expand an email thread   → get → get_related(children)
  email attachments        → get → get_related(children)

Batch / parallel queries:
  search and get both accept batched input so you can run N queries
  in a single MCP round-trip. Prefer batching over N sequential
  calls — same result, far less latency.

    get(ids=[idA, idB, idC])            → array of docs (or null per miss)
    search(queries=[{query:"X"}, {query:"X", source:"gmail"}])
                                        → array of result lists, in order

  Typical uses: pulling several search hits' bodies at once, trying
  the same topic across multiple languages, or probing several
  related phrasings in parallel. Independent kia tool calls (e.g.,
  search + digital_memory_info) can already be dispatched in parallel by
  the client — batch mode covers the case where the same tool fires
  multiple times.

Titles often understate body content. If a topic search misses,
search for distinctive body phrases. If results look irrelevant,
vary the wording — synonyms, narrower phrases, related terms —
before concluding nothing exists.

Point back to the original. Every search hit and fetched document
carries source_url — a deep link to the item where it lives (rows from
get_related carry the same link as url). When you present a finding,
include it so the user can open the original: as a link for web
sources (gmail, slack, notion, …), as a plain absolute path for file://
local files — metadata.absPath holds that path unescaped. Never invent
or guess one. Every document has a url — when presenting documents to the user, link each one, not just the first; if url is empty or non-http, cite by title and date.

Don't invent documents or details not returned by a tool.

Outbound: draft_reply / draft_message create user-confirmed drafts (nothing
sends without the user's confirmation); list_outbox shows drafts and
re-issues confirm links. send_draft sends one — only in chat confirmation
mode, and only after the user has explicitly agreed in this conversation;
in any other mode present the draft's confirm link instead.
`;
