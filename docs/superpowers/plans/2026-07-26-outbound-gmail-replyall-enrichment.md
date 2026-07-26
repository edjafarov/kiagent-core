# Gmail Reply-All Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 7 (§9) — Gmail thread documents store per-message `to`/`cc`/`replyTo`, so `draft_reply` with `reply_all: true` resolves real recipients instead of falling back to reply-to-sender.

**Architecture:** Pure projection change, no fetch change: the survey confirmed `threads.get?format=full` already returns every header and `collectHeaders` already retains them — `toDocument` just doesn't write them. Three moves: (1) fix the naive comma `split()` in `parser.ts` (it corrupts `"Doe, Jane" <j@x.com>` — poison if fed back into an outbound `To:` header); (2) project `to`/`cc`/`replyTo` into `metadata.messages[]`; (3) teach `resolveGmailReply` to honor `replyTo`, and prove the ingestion→resolution glue end to end. Enriched metadata reaches a doc only when its thread is re-pulled (history event or backfill) — gmail has no reconcile pass; the phase-5 fallback warning covers the long tail.

**Tech Stack:** TypeScript, jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §9, §12 phase 7.

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `dev`. **Prerequisites: the phase-1 plan AND the gmail-send plan (`2026-07-26-outbound-gmail-send.md`) fully landed** — `resolveGmailReply` must exist.
- Never amend/rebase/reset; never bypass hooks; no `Co-Authored-By`/promo. Subagents do NOT commit. No worktrees for jest.
- `contentHash` includes `metadata` (`write-tx.ts:25-36`): the moment `messages[]` gains fields, EVERY gmail thread doc takes the UPDATE branch on its next re-pull — new seq, FTS reindex. One-time churn per thread, by design; do not "optimize" it away.
- Never a guessed recipient: un-enriched docs keep the explicit fallback warning; enriched docs resolve exactly what the headers said.
- Final gate: FULL `npm test` + `npm run lint` + `npm run typecheck`.

## Parallel Execution Guide (subagent-driven)

Implementers on **sonnet**, one per task, same checkout:

- **Wave 1:** Task 1 (quote-aware address split)
- **Wave 2:** Task 2 (metadata projection)
- **Wave 3:** Task 3 (replyTo in the resolver + glue test)
- **Wave 4:** Task 4 (full gates)

(Serial: Task 2's assertions depend on Task 1's splitter; Task 3 consumes Task 2's shape.)

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/main/sources/gmail/parser.ts` | modify | quote-aware `split` |
| `src/main/sources/gmail/to-document.ts` | modify | `messages[].to/cc/replyTo` |
| `src/main/outbound/resolve-gmail.ts` | modify | honor `replyTo` |

---

### Task 1: Quote-aware address splitting in `parser.ts`

**Files:**
- Modify: `src/main/sources/gmail/parser.ts` (the `split` helper, ~lines 118-125)
- Test: `src/main/sources/gmail/__tests__/parser.test.ts` (append; create mirroring the sibling harness if absent)

**Interfaces:**
- Produces: same exported surface — `ParsedEmail.to`/`cc` — but display names containing commas survive intact. Later tasks and the resolver rely on entries being whole addresses.

- [ ] **Step 1: Write the failing test**

```ts
  it('splits address lists on top-level commas only', () => {
    // build a message fixture whose To header is:
    //   '"Doe, Jane" <jane@x.com>, Bob <bob@x.com>'
    // via the file's existing GmailMessage fixture helper, then:
    expect(parsed.to).toEqual(['"Doe, Jane" <jane@x.com>', 'Bob <bob@x.com>']);
  });
```

(Use the test file's existing message-fixture builder; the assertion is the point.)

- [ ] **Step 2: FAIL** — `npx jest src/main/sources/gmail/__tests__/parser.test.ts -v` — the naive split yields three fragments.

- [ ] **Step 3: Implement** — replace the `split` body:

```ts
/** Split an address-list header on top-level commas — a comma inside a
 *  double-quoted display name ("Doe, Jane" <j@x.com>) is part of the name,
 *  not a separator. These strings feed outbound To: headers, so a corrupted
 *  entry would become a bogus recipient. */
function split(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}
```

- [ ] **Step 4: PASS** — `npx jest src/main/sources/gmail -v` (whole gmail suite — the old behavior for comma-free lists must be unchanged).

- [ ] **Step 5: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/main/sources/gmail/parser.ts src/main/sources/gmail/__tests__/parser.test.ts
git commit -m "fix(gmail): address-list split respects quoted display names"
```

---

### Task 2: Project per-message recipients into thread metadata

**Files:**
- Modify: `src/main/sources/gmail/to-document.ts` (the `messages:` map, ~lines 86-91)
- Test: `src/main/sources/gmail/__tests__/to-document.test.ts` (the `messages[]` type annotation at ~lines 97-112 + new assertions)

**Interfaces:**
- Consumes: `ParsedEmail` (`to: string[]`, `cc: string[]`, `headers` — the full lowercased header map retaining `reply-to`).
- Produces (consumed by `resolveGmailReply`): `metadata.messages[]` entries gain

```ts
        to: m.to,
        cc: m.cc,
        replyTo: m.headers['reply-to'] ?? null,
```

(beside the existing `id`/`from`/`date`/`snippet` — nothing removed, nothing renamed).

- [ ] **Step 1: Write the failing test** — extend the existing thread-metadata test: a two-message fixture where message 2 has `To: me@gmail.com, Carol <carol@x.com>`, `Cc: dave@x.com`, `Reply-To: list@x.com`; assert:

```ts
    const messages = meta.messages as Array<{
      id: string;
      from: string;
      date: string;
      snippet: string;
      to: string[];
      cc: string[];
      replyTo: string | null;
    }>;
    expect(messages[1].to).toEqual(['me@gmail.com', 'Carol <carol@x.com>']);
    expect(messages[1].cc).toEqual(['dave@x.com']);
    expect(messages[1].replyTo).toBe('list@x.com');
    expect(messages[0].replyTo).toBeNull();
```

- [ ] **Step 2: FAIL** — `npx jest src/main/sources/gmail/__tests__/to-document.test.ts -v`.
- [ ] **Step 3: Implement** the three-line projection addition.
- [ ] **Step 4: PASS** — `npx jest src/main/sources/gmail -v`.
- [ ] **Step 5: Commit**

```bash
git add src/main/sources/gmail/to-document.ts src/main/sources/gmail/__tests__/to-document.test.ts
git commit -m "feat(gmail): thread docs store per-message to/cc/replyTo (spec §9 enrichment)"
```

---

### Task 3: `replyTo` in the resolver + ingestion→resolution glue test

**Files:**
- Modify: `src/main/outbound/resolve-gmail.ts`
- Test: `src/main/outbound/__tests__/resolve-gmail.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's enriched `messages[]` shape.
- Produces: reply targeting honors `Reply-To` exactly like the imap resolver does — `reply`: target message's `replyTo ?? from`; `reply_all` (enriched): `to = dedupe([(last.replyTo ?? last.from), ...last.to]) minus self`. Un-enriched behavior byte-identical to phase 5 (fallback + warning).

- [ ] **Step 1: Write the failing tests**

```ts
  it('reply honors Reply-To over From', () => {
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m1@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            to: ['me@gmail.com'],
            cc: [],
            replyTo: 'list@x.com',
          },
        ],
      }),
      SELF,
      false,
    );
    expect(r.to).toEqual(['list@x.com']);
  });

  it('glue: toDocument output feeds reply_all end to end', () => {
    // Build a raw two-message thread through the REAL ingestion path:
    // parseGmailMessage fixtures -> toDocument (import from
    // @main/sources/gmail/to-document; reuse the fixture builder style from
    // its own test file), wrap the resulting DocumentInput as a Document
    // ({ id: 'd', accountId: 'a', ...threadDoc }), then:
    const r = resolveGmailReply(asDocument, ['me@gmail.com'], true);
    expect(r.warnings).toEqual([]); // enriched — no fallback
    expect(r.to).toContain('Carol <carol@x.com>');
    expect(r.cc).toEqual(['dave@x.com']);
  });
```

(The glue test is the point of this task: the two modules were built against a described shape in separate plans — this is the one test where the real producer meets the real consumer.)

- [ ] **Step 2: FAIL** — `npx jest src/main/outbound/__tests__/resolve-gmail.test.ts -v` (the replyTo case).
- [ ] **Step 3: Implement** the `replyTo ?? from` substitution at both target sites in `resolve-gmail.ts`.
- [ ] **Step 4: PASS** — `npx jest src/main/outbound src/main/sources/gmail -v`.
- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/resolve-gmail.ts src/main/outbound/__tests__/resolve-gmail.test.ts
git commit -m "feat(outbound): gmail reply resolution honors Reply-To; ingestion glue covered"
```

---

### Task 4: Full gates + notes

- [ ] **Step 1:** `npm test` && `npm run lint` && `npm run typecheck` — all green.
- [ ] **Step 2:** Report, including:
- Enrichment reaches a doc only when its thread is next re-pulled (history event or backfill) — gmail has no reconcile; quiet old threads keep the fallback warning indefinitely. If the founding cohort hits this in practice, the candidate fix is a one-time cursor reset per account (forces backfill) — decide then, not now.
- One-time contentHash churn: every re-pulled gmail thread rewrites (new seq + FTS reindex) — expected, benign, worth a release-note line.
- Spec cross-off: phase 7 of §12.
