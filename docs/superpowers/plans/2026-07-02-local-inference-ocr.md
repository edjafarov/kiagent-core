# Local Inference & OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the legacy deep-extraction subsystem onto the greenfield contracts: a hardware-tiered auto-downloading local LLM provider (llama-server), a zero-download native macOS OCR provider, and a bundled two-pass vision worker that makes scanned PDFs/images searchable — plus Gmail attachment documents so email scans feed it.

**Architecture:** Two `InferenceProvider`s register on the existing inference plane (`apple-vision` for a new `read` kind = OCR; `local-llm` for `complete`+`see`). A bundled `Worker` ("vision") consumes the document feed, OCRs via `read`, defers text-poor docs, and VLM-describes them on the scheduled re-drive; results write back through a new `enrich` arm on the consumer commit. Spec: `docs/superpowers/specs/2026-07-02-local-inference-ocr-design.md`.

**Tech Stack:** TypeScript (Electron main), better-sqlite3, jest, llama.cpp `llama-server` (bundled binary, HTTP), Apple Vision via bundled `kia-vision` Swift helper, `@hyzyla/pdfium` + `pngjs` for PDF rasterization.

## Global Constraints

- Reference implementation lives at `/Users/edjafarov/work/kiagent-ref` (read-only; copy files from there where a task says so).
- NEVER print, quote, or log the contents of `src/main/sources/gmail/client-credentials.ts` (contains an OAuth client secret). Don't modify that file.
- Contract changes are ADDITIVE only — no field renames. Every contract change made in `src/shared/contracts.ts` must also be mirrored in the blueprint `concept/greenfield.ts` (the task says exactly where).
- Repo has pre-existing prettier drift; CI runs jest only. Match the local style of each file you touch; do not reformat unrelated lines.
- Run tests with `npx jest <path>` from the repo root. Full suite: `npm test`. Typecheck: `npx tsc --noEmit`.
- All new main-process code goes under `src/main/providers/` and `src/main/workers/` (new directories) except where a task modifies existing files.
- Node/Electron main-process code: use `import` syntax matching the surrounding files; path alias `@shared/contracts` is available.

---

### Task 1: `enrich` arm on the consumer commit

**Files:**
- Modify: `src/shared/contracts.ts` (CommitBatch, ~line 137)
- Modify: `concept/greenfield.ts` (CommitBatch, ~line 253)
- Modify: `src/main/core/store/store.ts` (commitTx consumer branch, ~line 425)
- Test: `src/main/core/store/__tests__/store.test.ts`

**Interfaces:**
- Consumes: existing `commitTx`, `ftsUpsert`, `appendChange`, `deps.detectLanguages`, `now()` in store.ts.
- Produces: `EnrichInput` type exported from contracts; `store.commit({consumer, cursor, enrich})` behavior. Tasks 3, 11 rely on `EnrichInput` exactly as defined here.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('store', …)` block in `src/main/core/store/__tests__/store.test.ts`:

```ts
  it('enrich: updates markdown + merged metadata, reindexes FTS, one feed change', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('scan', { markdown: null, metadata: { mime: 'application/pdf' } })],
      cursor: 1,
    });
    const before = await store.read.byExternalId(accountId, 'scan', 'note');
    const head = store.headSeq();

    await store.commit({
      consumer: 'worker:vision:v1',
      cursor: 7,
      enrich: [
        {
          documentId: before!.id,
          markdown: 'invoice total 42 EUR',
          metadata: { extraction: { engine: 'local-ocr' } },
        },
      ],
    });

    const after = await store.read.document(before!.id);
    expect(after?.markdown).toBe('invoice total 42 EUR');
    expect((after?.metadata as { mime?: string }).mime).toBe('application/pdf'); // merged, not replaced
    expect((after?.metadata as { extraction?: { engine: string } }).extraction?.engine).toBe('local-ocr');
    expect(after?.contentHash).toBe(before?.contentHash); // untouched — source content still dedupes
    expect(store.consumerCursor('worker:vision:v1')).toBe(7);
    expect(store.headSeq()).toBe(head + 1); // exactly one 'document' change

    const hits = await store.read.search({ text: 'invoice' });
    expect(hits.map((h) => h.externalId)).toEqual(['scan']);
  });

  it('enrich: unknown documentId is skipped silently (doc purged since worker read it)', async () => {
    await store.commit({
      consumer: 'worker:vision:v1',
      cursor: 8,
      enrich: [{ documentId: 'no-such-id', markdown: 'x' }],
    });
    expect(store.consumerCursor('worker:vision:v1')).toBe(8);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/main/core/store/__tests__/store.test.ts -t 'enrich'`
Expected: FAIL — TypeScript error (`enrich` not in CommitBatch) or runtime ignore.

- [ ] **Step 3: Add the contract**

In `src/shared/contracts.ts`, directly above `CommitBatch` (~line 135), add:

```ts
/** Write vision/OCR output back onto an EXISTING document — the second half
 *  of the two-pass pipeline. Merges metadata, replaces markdown, reindexes
 *  FTS, emits a 'document' change. `contentHash` is untouched: the source's
 *  own content still dedupes on its next real change. */
export interface EnrichInput {
  documentId: DocumentId;
  markdown: string;
  metadata?: Record<string, unknown>;
}
```

and extend the consumer arm (line ~148):

```ts
  | { consumer: string; cursor: Seq; documents?: DocumentInput[]; enrich?: EnrichInput[] }
```

Mirror both edits in `concept/greenfield.ts` at its `CommitBatch` (~line 253–264), keeping that file's comment style.

- [ ] **Step 4: Implement the store branch**

In `src/main/core/store/store.ts`, inside `commitTx`'s `if ('consumer' in batch)` branch, after the `batch.documents` loop (after line ~438) and before `return last;`:

```ts
      if (batch.enrich?.length) {
        for (const e of batch.enrich) {
          const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(e.documentId) as
            | DocRow
            | undefined;
          if (!row) continue; // purged since the worker read it — enrich is best-effort
          const seq = appendChange('document', row.id);
          const metadata = e.metadata
            ? JSON.stringify({ ...(JSON.parse(row.metadata) as Record<string, unknown>), ...e.metadata })
            : row.metadata;
          const text = `${row.title ?? ''}\n${e.markdown}`.trim();
          const languages = text ? deps.detectLanguages(text) : [];
          db.prepare(
            `UPDATE documents SET markdown=?, metadata=?, seq=?, languages=?, updated_at=? WHERE id=?`,
          ).run(e.markdown, metadata, seq, JSON.stringify(languages), now(), row.id);
          ftsUpsert(row.id, row.title, e.markdown);
          last = seq;
        }
      }
```

Check the exact `DocRow` field name for the metadata column (see `toDocument(r: DocRow)` at ~line 126) and adjust `row.metadata` if the row field is named differently.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/main/core/store/__tests__/store.test.ts`
Expected: PASS (all store tests, including the two new ones).

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/shared/contracts.ts concept/greenfield.ts src/main/core/store/store.ts src/main/core/store/__tests__/store.test.ts
git commit -m "feat(store): enrich arm on the consumer commit — vision write-back"
```

---

### Task 2: `read` inference kind + plane routing

**Files:**
- Modify: `src/shared/contracts.ts` (Inference ~line 302, InferenceProvider ~line 324)
- Modify: `concept/greenfield.ts` (§4 ~lines 409–439; DocumentInput comment ~lines 138–146)
- Modify: `src/main/core/inference.ts`
- Modify: `src/shared/ipc.ts` (`inference:providers` res type ~line 119)
- Create: `src/main/core/__tests__/inference.test.ts`

**Interfaces:**
- Consumes: existing `createInference(logs)`, `gate`, `pick`.
- Produces: `Inference.read(image: Uint8Array, opts?: { mime?: string; lane?: Lane }): Promise<string>`; `InferenceProvider.supports: Array<'complete' | 'see' | 'read'>`; `handle` req kind union gains `'read'`. Tasks 3, 8, 11, 14 rely on these signatures.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/__tests__/inference.test.ts`:

```ts
import type { InferenceProvider } from '@shared/contracts';

import { createInference } from '../inference';

const noopLogs = { log: () => {} };

function provider(
  id: string,
  supports: InferenceProvider['supports'],
  result: string,
): InferenceProvider {
  return {
    id,
    supports,
    status: () => 'ready',
    handle: async (req) => `${result}:${req.kind}`,
  };
}

describe('inference plane', () => {
  it('read routes to the first ready provider supporting read', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('llm', ['complete', 'see'], 'llm'));
    plane.register(provider('ocr', ['read'], 'ocr'));
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
    await expect(plane.see(new Uint8Array([1]), 'p')).resolves.toBe('llm:see');
  });

  it('read with no provider throws the settings hint', async () => {
    const plane = createInference(noopLogs);
    await expect(plane.read(new Uint8Array([1]))).rejects.toThrow(/no inference provider/);
  });

  it('background lane parks until the scheduler opens it', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setBackgroundOpen(false);
    let done = false;
    const p = plane.read(new Uint8Array([1]), { lane: 'background' }).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    plane.setBackgroundOpen(true);
    await expect(p).resolves.toBe('ocr:read');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/__tests__/inference.test.ts`
Expected: FAIL — `plane.read is not a function` / type error.

- [ ] **Step 3: Extend the contracts**

`src/shared/contracts.ts`:
- In `Inference` (~line 302), after `see(...)`:

```ts
  /** OCR only: image/page in, plain text out. Distinct from `see` because
   *  cheap native OCR and the costly VLM route to DIFFERENT providers —
   *  the two-pass pipeline addresses them by kind. */
  read(image: Uint8Array, opts?: { mime?: string; lane?: Lane }): Promise<string>;
```

- In `InferenceProvider` (~line 324): `supports: Array<'complete' | 'see' | 'read'>` and `handle(req: { kind: 'complete' | 'see' | 'read'; payload: unknown; lane: Lane })`.

`src/shared/ipc.ts` (~line 122): `supports: Array<'complete' | 'see' | 'read'>;`

`concept/greenfield.ts`:
- Mirror the `Inference.read` addition and the two union widenings in §4 (~lines 413–438).
- In the `DocumentInput` comment (~lines 138–146), change `"install better OCR" = install an InferenceProvider supporting 'see'` to `"install better OCR" = install an InferenceProvider supporting 'read' (OCR) or 'see' (vision)`.

- [ ] **Step 4: Implement `read` in the plane**

In `src/main/core/inference.ts`, `pick` already takes the kind — widen its parameter to `'complete' | 'see' | 'read'`. Add to the returned object after `see`:

```ts
    async read(image, opts) {
      const lane = opts?.lane ?? 'interactive';
      await gate(lane);
      const p = pick('read');
      const out = await p.handle({
        kind: 'read',
        payload: { image, mime: opts?.mime },
        lane,
      });
      return String(out);
    },
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx jest src/main/core/__tests__/inference.test.ts && npx tsc --noEmit`
Expected: PASS / clean. (`tsc` may flag `main.ts`'s provider mapping if it spells the supports type — fix by importing the widened type, not by casting.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts.ts concept/greenfield.ts src/main/core/inference.ts src/shared/ipc.ts src/main/core/__tests__/inference.test.ts
git commit -m "feat(inference): third kind 'read' (OCR) routed separately from 'see'"
```

---

### Task 3: WorkerSession `see`/`read`/`enrich`

**Files:**
- Modify: `src/shared/contracts.ts` (WorkerSession ~line 339)
- Modify: `concept/greenfield.ts` (WorkerSession §5 ~line 446)
- Modify: `src/main/core/engine/engine.ts` (workOne ~lines 125–176, attach ~lines 341–398, rerunDeferred ~lines 400–418)
- Test: `src/main/core/engine/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `EnrichInput` (Task 1), `Inference.read`/`see` (Task 2).
- Produces: `WorkerSession.see(image, prompt, opts?: {mime?: string})`, `WorkerSession.read(image, opts?: {mime?: string})`, `WorkerSession.enrich(e: EnrichInput): void` — all Task 11 uses; `workOne` now returns `{ docs: DocumentInput[]; enrich: EnrichInput[] }`.

- [ ] **Step 1: Write the failing test**

In `src/main/core/engine/__tests__/engine.test.ts`, add (using the file's existing `makeStore`/`doc`/`fakeSource` harness and however existing worker tests construct `createEngine` deps — follow the closest existing worker test):

```ts
  it('worker session: read/see route to the plane, enrich commits with the cursor', async () => {
    // fake inference recording lanes
    const calls: string[] = [];
    const inference = {
      complete: async () => 'c',
      see: async (_i: Uint8Array, prompt: string) => {
        calls.push(`see:${prompt}`);
        return 'described';
      },
      read: async () => {
        calls.push('read');
        return 'ocr text';
      },
    };
    const engine = createEngine({
      store,
      sources: { get: () => undefined },
      inference,
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });
    const account = await store.createAccount({ source: 'test', identifier: 'x' });
    const worker: Worker = {
      name: 'vision',
      version: 1,
      matches: (ch) => ch.kind === 'document' && ch.document.externalId === 'scan',
      async work(ch, session) {
        if (ch.kind !== 'document') return 'skip';
        await session.read(new Uint8Array([1]));
        await session.see(new Uint8Array([1]), 'describe');
        session.enrich({ documentId: ch.document.id, markdown: 'enriched body' });
        return 'done';
      },
    };
    const handle = engine.attach(worker);
    await store.commit({ account: account.id, documents: [doc('scan')], cursor: 1 });
    await waitFor(async () => {
      const d = await store.read.byExternalId(account.id, 'scan', 'note');
      return d?.markdown === 'enriched body';
    });
    expect(calls).toEqual(['read', 'see:describe']);
    await handle.stop();
  });
```

If the file has no `waitFor` helper, add one at the top level:

```ts
async function waitFor(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
```

Match the deps object shape to what `createEngine` actually requires (check its `EngineDeps` type — `refreshers` may be required; pass `new Map()`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/engine/__tests__/engine.test.ts -t 'worker session'`
Expected: FAIL — `session.read is not a function`.

- [ ] **Step 3: Extend WorkerSession contract**

`src/shared/contracts.ts` `WorkerSession` (~line 339), after `inference(...)`:

```ts
  /** Vision sugar over the Inference plane, pinned to the 'background' lane. */
  see(image: Uint8Array, prompt: string, opts?: { mime?: string }): Promise<string>;
  /** OCR sugar over the Inference plane, pinned to the 'background' lane. */
  read(image: Uint8Array, opts?: { mime?: string }): Promise<string>;
  /** Write back onto an EXISTING document — committed by the ENGINE in the
   *  SAME transaction as this worker's cursor (see CommitBatch.enrich). */
  enrich(e: EnrichInput): void;
```

Mirror in `concept/greenfield.ts` §5 WorkerSession.

- [ ] **Step 4: Implement in the engine**

In `src/main/core/engine/engine.ts`:

1. Change `workOne`'s return type to `Promise<{ docs: DocumentInput[]; enrich: EnrichInput[] }>` (import `EnrichInput` from `@shared/contracts`). Inside, add `const enriched: EnrichInput[] = [];` next to `emitted`, extend the session:

```ts
      see(image, prompt, opts) {
        return deps.inference.see(image, prompt, { ...opts, lane: 'background' });
      },
      read(image, opts) {
        return deps.inference.read(image, { ...opts, lane: 'background' });
      },
      enrich(e) {
        enriched.push(e);
      },
```

and change every `return emitted;` to `return { docs: emitted, enrich: enriched };`.

2. In `attach` (~line 351): track both accumulators:

```ts
            let emitted: DocumentInput[] = [];
            let enrich: EnrichInput[] = [];
            ...
                const r = await workOne(worker, change, abort.signal);
                emitted = emitted.concat(r.docs);
                enrich = enrich.concat(r.enrich);
            ...
            await store.commit({
              consumer,
              cursor,
              documents: emitted.length ? emitted : undefined,
              enrich: enrich.length ? enrich : undefined,
            });
```

3. Same accumulation in `rerunDeferred` (~lines 406–417), and commit when `emitted.length || enrich.length`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx jest src/main/core/engine && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts.ts concept/greenfield.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/engine.test.ts
git commit -m "feat(engine): worker session gains see/read sugar and enrich write-back"
```

---

### Task 4: `toDocument` may return several documents

**Files:**
- Modify: `src/shared/contracts.ts` (Source.toDocument ~line 285)
- Modify: `concept/greenfield.ts` (Source.toDocument comment)
- Modify: `src/main/core/engine/engine.ts` (run loop ~line 256)
- Test: `src/main/core/engine/__tests__/engine.test.ts`

**Interfaces:**
- Produces: `toDocument(item: Item): DocumentInput | DocumentInput[] | null` — Task 5 relies on the array form. Existing single-doc sources keep compiling (single is assignable to the union).

- [ ] **Step 1: Write the failing test**

In `engine.test.ts`, add a source whose `toDocument` returns an array (reuse the `fakeSource` pattern; one item expands to a parent + child):

```ts
  it('toDocument returning an array commits every document, parent first', async () => {
    const source: Source<number, string> = {
      descriptor: { id: 'multi', name: 'Multi', documentTypes: ['note', 'attachment'], auth: 'none' },
      async connect() {
        return { identifier: 'multi@test' };
      },
      async *pull() {
        yield { phase: 'live' as const, items: ['t1'], cursor: 1 };
      },
      toDocument: (id) => [
        doc(id),
        {
          ...doc(`${id}/att`),
          type: 'attachment',
          parent: { externalId: id, type: 'note' },
        },
      ],
    };
    // attach account + run via the file's existing run-account pattern, then:
    await waitFor(async () => (await store.read.count({ account: account.id })) === 2);
    const child = await store.read.byExternalId(account.id, 't1/att', 'attachment');
    const parent = await store.read.byExternalId(account.id, 't1', 'note');
    expect(child?.parentId).toBe(parent?.id); // resolved in the same tx
  });
```

Adapt the "run the source" boilerplate from the nearest existing `engine.run` test in the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/engine/__tests__/engine.test.ts -t 'toDocument returning an array'`
Expected: FAIL (type error on array return).

- [ ] **Step 3: Widen the contract and flatten in the engine**

`src/shared/contracts.ts` line ~285:

```ts
  /** PURE — unit-testable with fixtures. One upstream item may map to
   *  several documents (e.g. an email thread plus its attachments). */
  toDocument(item: Item): DocumentInput | DocumentInput[] | null;
```

Mirror in `concept/greenfield.ts`. In `engine.ts`'s run loop (~line 256), replace the single-input handling (it currently does `const input = source.toDocument(item); if (input) …convert/push…`) with:

```ts
                for (const item of batch.items) {
                  const out = source.toDocument(item);
                  if (!out) continue;
                  const inputs = Array.isArray(out) ? out : [out];
                  for (const input of inputs) {
                    documents.push(await deps.convert(input));
                  }
                }
```

Keep whatever the existing loop does with `convert` (read lines 250–265 first and preserve it exactly — only the flattening is new).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx jest src/main/core/engine && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts concept/greenfield.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/engine.test.ts
git commit -m "feat(engine): toDocument may expand one item into several documents"
```

---

### Task 5: Gmail attachment child documents

**Files:**
- Modify: `src/main/sources/gmail/to-document.ts`
- Modify: `src/main/sources/gmail/gmail-source.ts` (descriptor.documentTypes ~line 26)
- Test: `src/main/sources/gmail/__tests__/to-document.test.ts`

**Interfaces:**
- Consumes: `ParsedAttachment {messageId, partId, attachmentId, filename, mimeType, sizeBytes}` from `parser.ts`; array-returning `toDocument` (Task 4).
- Produces: attachment `DocumentInput`s with `type: 'attachment'`, `externalId: `${messageId}/${partId}``, `metadata: {mime, filename, sizeBytes, messageId, partId, attachmentId}`, `parent: {externalId: threadId, type: 'email.thread'}`. Tasks 6 and 11 read exactly these metadata keys.

- [ ] **Step 1: Write the failing test**

In `__tests__/to-document.test.ts`, add (reusing the file's existing fixture-building helpers for `GmailThreadItem`/messages — read the file first and construct a thread whose message has one PDF attachment part and one tiny inline image part):

```ts
  it('emits attachment child documents keyed by messageId/partId', () => {
    const item = threadWith([
      messageWith({
        attachments: [
          { messageId: 'm1', partId: '2', attachmentId: 'AAA', filename: 'scan.pdf', mimeType: 'application/pdf', sizeBytes: 50_000 },
          { messageId: 'm1', partId: '3', attachmentId: 'BBB', filename: 'sig.png', mimeType: 'image/png', sizeBytes: 900 },
        ],
      }),
    ]);
    const out = toDocument(item);
    expect(Array.isArray(out)).toBe(true);
    const docs = out as DocumentInput[];
    const atts = docs.filter((d) => d.type === 'attachment');
    expect(atts).toHaveLength(1); // tiny image skipped as decorative
    expect(atts[0].externalId).toBe('m1/2');
    expect(atts[0].markdown).toBeNull();
    expect(atts[0].parent).toEqual({ externalId: item.id, type: 'email.thread' });
    expect(atts[0].metadata).toMatchObject({
      mime: 'application/pdf',
      filename: 'scan.pdf',
      sizeBytes: 50_000,
      messageId: 'm1',
      partId: '2',
      attachmentId: 'AAA',
    });
  });
```

NOTE: the attachments in the fixture must flow through however `toDocument` obtains `m.attachments` today (it iterates `m.attachments` at ~line 54 — the parsed-message shape). Build the fixture at that layer, matching the file's existing tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/sources/gmail/__tests__/to-document.test.ts -t 'attachment child'`
Expected: FAIL — `toDocument` returns a single doc.

- [ ] **Step 3: Implement**

In `to-document.ts`:

```ts
/** Inline images under this size are signature/pixel noise — never stored. */
const TINY_ATTACHMENT_IMAGE_BYTES = 8 * 1024;
```

Change `toDocument` to build the thread doc exactly as today, then:

```ts
  const attachments: DocumentInput[] = [];
  for (const m of messages) {
    for (const att of m.attachments) {
      if (att.mimeType.startsWith('image/') && att.sizeBytes < TINY_ATTACHMENT_IMAGE_BYTES) continue;
      attachments.push({
        externalId: `${att.messageId}/${att.partId}`,
        type: 'attachment',
        title: att.filename || null,
        markdown: null, // text-poor by construction — the vision worker's pool
        url: threadDoc.url,
        metadata: {
          mime: att.mimeType,
          filename: att.filename,
          sizeBytes: att.sizeBytes,
          messageId: att.messageId,
          partId: att.partId,
          attachmentId: att.attachmentId, // rotates — fetchBytes re-resolves via partId
        },
        createdAt: m.date ? m.date.toISOString() : threadDoc.createdAt,
        parent: { externalId: item.id, type: GMAIL_THREAD_DOCUMENT_TYPE },
      });
    }
  }
  return attachments.length ? [threadDoc, ...attachments] : threadDoc;
```

(Use the file's actual local variable names for the parsed messages and the built thread doc.) In `gmail-source.ts`'s descriptor, add `'attachment'` to `documentTypes`, and update the stale comment at ~lines 30–31 saying attachments are out of scope.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx jest src/main/sources/gmail && npx tsc --noEmit`
Expected: PASS / clean.

```bash
git add src/main/sources/gmail/to-document.ts src/main/sources/gmail/gmail-source.ts src/main/sources/gmail/__tests__/to-document.test.ts
git commit -m "feat(gmail): emit attachment child documents (thread-parented)"
```

---

### Task 6: Gmail `fetchBytes`

**Files:**
- Modify: `src/main/sources/gmail/gmail-api.ts`
- Modify: `src/main/sources/gmail/gmail-source.ts`
- Test: `src/main/sources/gmail/__tests__/fetch-bytes.test.ts` (create)

**Interfaces:**
- Consumes: `fetchGmail<T>(session, url)` and `BASE` in gmail-api.ts; attachment metadata keys from Task 5; the parser's message→attachments function (the same one `to-document` uses).
- Produces: `gmailSource.fetchBytes(session, doc): Promise<Uint8Array | null>` — the engine's `WorkerSession.fetchBytes` (already wired) will find it.

- [ ] **Step 1: Write the failing test**

Create `__tests__/fetch-bytes.test.ts`. Mock at the `gmail-api` module boundary (jest module mock), not global fetch:

```ts
import { gmailSource } from '../gmail-source';
import * as api from '../gmail-api';

jest.mock('../gmail-api', () => ({
  ...jest.requireActual('../gmail-api'),
  getAttachment: jest.fn(),
  getMessage: jest.fn(),
}));

const session = {
  account: { id: 'a1', source: 'gmail', identifier: 'me@x' },
  signal: new AbortController().signal,
  credentials: async () => ({ accessToken: 't' }),
  log: () => {},
} as never;

const attachmentDoc = {
  id: 'd1',
  type: 'attachment',
  metadata: { messageId: 'm1', partId: '2', attachmentId: 'OLD', mime: 'application/pdf' },
} as never;

describe('gmail fetchBytes', () => {
  it('decodes base64url attachment bytes', async () => {
    (api.getAttachment as jest.Mock).mockResolvedValue({
      size: 3,
      data: Buffer.from([1, 2, 3]).toString('base64url'),
    });
    const bytes = await gmailSource.fetchBytes!(session, attachmentDoc);
    expect([...bytes!]).toEqual([1, 2, 3]);
    expect(api.getAttachment).toHaveBeenCalledWith(session, 'm1', 'OLD');
  });

  it('re-resolves a rotated attachmentId via the message part tree', async () => {
    (api.getAttachment as jest.Mock)
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({ size: 1, data: Buffer.from([9]).toString('base64url') });
    (api.getMessage as jest.Mock).mockResolvedValue(FIXTURE_MESSAGE_WITH_PART_2_NEW_ID);
    const bytes = await gmailSource.fetchBytes!(session, attachmentDoc);
    expect([...bytes!]).toEqual([9]);
    expect(api.getAttachment).toHaveBeenLastCalledWith(session, 'm1', 'NEW');
  });

  it('returns null for docs without attachment metadata', async () => {
    const out = await gmailSource.fetchBytes!(session, { id: 'x', type: 'email.thread', metadata: {} } as never);
    expect(out).toBeNull();
  });
});
```

Build `FIXTURE_MESSAGE_WITH_PART_2_NEW_ID` as a raw `GmailApiMessage` whose payload part with `partId: '2'` carries `body.attachmentId: 'NEW'` (copy the part-tree shape from an existing parser/to-document fixture).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/sources/gmail/__tests__/fetch-bytes.test.ts`
Expected: FAIL — `fetchBytes` undefined / `getAttachment` not exported.

- [ ] **Step 3: Implement**

`gmail-api.ts` additions:

```ts
export interface AttachmentBody {
  size: number;
  data?: string; // base64url
}

export function getAttachment(
  session: Session,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentBody> {
  return fetchGmail(
    session,
    `${BASE}/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`,
  );
}

export function getMessage(session: Session, id: string): Promise<GmailApiMessage> {
  return fetchGmail(session, `${BASE}/messages/${id}?format=full`);
}
```

`gmail-source.ts` — add to the exported `gmailSource` object:

```ts
  async fetchBytes(session, doc) {
    const meta = doc.metadata as {
      messageId?: string;
      partId?: string;
      attachmentId?: string;
    };
    if (!meta.messageId || !meta.attachmentId) return null;
    const decode = (data: string) => new Uint8Array(Buffer.from(data, 'base64url'));
    try {
      const res = await getAttachment(session, meta.messageId, meta.attachmentId);
      if (res.data) return decode(res.data);
    } catch {
      // attachment ids rotate between API sessions — fall through and re-resolve
    }
    const msg = await getMessage(session, meta.messageId);
    const fresh = attachmentsOf(msg).find((a) => a.partId === meta.partId);
    if (!fresh) return null;
    const res = await getAttachment(session, meta.messageId, fresh.attachmentId);
    return res.data ? decode(res.data) : null;
  },
```

where `attachmentsOf` is the parser function `to-document.ts` already uses to get `m.attachments` for a raw message (export it from `parser.ts` if it isn't already; do NOT duplicate the walk).

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx jest src/main/sources/gmail && npx tsc --noEmit`

```bash
git add src/main/sources/gmail
git commit -m "feat(gmail): fetchBytes for attachments with rotated-id re-resolve"
```

---

### Task 7: `AppPrefs.models`

**Files:**
- Modify: `src/shared/contracts.ts` (AppPrefs ~line 501)
- Modify: `concept/greenfield.ts` (AppPrefs in §8)
- Modify: `src/main/core/prefs.ts` (DEFAULT_PREFS, sanitize, patch deep-merge)
- Test: `src/main/core/__tests__/prefs.test.ts` (create if absent; extend if present)

**Interfaces:**
- Produces: `AppPrefs.models: { override: string; autoInstall: boolean }` (defaults `{ override: 'auto', autoInstall: true }`). Tasks 14, 15, 16 read these.

- [ ] **Step 1: Write the failing test**

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPrefs, DEFAULT_PREFS } from '../prefs';

describe('prefs.models', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults to auto + autoInstall', () => {
    expect(DEFAULT_PREFS.models).toEqual({ override: 'auto', autoInstall: true });
    expect(createPrefs(dir).get().models).toEqual({ override: 'auto', autoInstall: true });
  });

  it('patch deep-merges and survives reload', async () => {
    const p = createPrefs(dir);
    await p.patch({ models: { ...p.get().models, autoInstall: false } });
    expect(createPrefs(dir).get().models).toEqual({ override: 'auto', autoInstall: false });
  });

  it('sanitize rejects garbage', () => {
    fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ models: { override: 42 } }));
    expect(createPrefs(dir).get().models).toEqual({ override: 'auto', autoInstall: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/__tests__/prefs.test.ts`
Expected: FAIL — `models` missing.

- [ ] **Step 3: Implement**

`contracts.ts` AppPrefs (+ mirror in `concept/greenfield.ts` §8):

```ts
  /** Local model management: `override` pins a catalog model id ('auto' =
   *  hardware tier), `autoInstall` lets deferred vision work trigger the
   *  download (a Settings Cancel sets it false). */
  models: { override: string; autoInstall: boolean };
```

`prefs.ts`: add to `DEFAULT_PREFS`: `models: { override: 'auto', autoInstall: true },`. In `sanitize`:

```ts
    models: {
      override:
        typeof r.models?.override === 'string' && r.models.override ? r.models.override : 'auto',
      autoInstall: r.models?.autoInstall !== false,
    },
```

In `patch`'s merge object add `models: { ...current.models, ...(p.models ?? {}) },`.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx jest src/main/core/__tests__/prefs.test.ts && npx tsc --noEmit`

```bash
git add src/shared/contracts.ts concept/greenfield.ts src/main/core/prefs.ts src/main/core/__tests__/prefs.test.ts
git commit -m "feat(prefs): models pref — override + autoInstall"
```

---

### Task 8: `apple-vision` provider + `kia-vision` helper driver

**Files:**
- Create: `src/main/providers/apple-vision/vision-helper.ts` (ported)
- Create: `src/main/providers/apple-vision/provider.ts`
- Test: `src/main/providers/apple-vision/__tests__/provider.test.ts`
- Reference: `/Users/edjafarov/work/kiagent-ref/src/main/inference/vision-helper.ts`, ref `src/main/inference/ocr/native-vision.ts`, ref `src/main/inference/rasterize/core-graphics.ts`

**Interfaces:**
- Produces:
  - `makeVisionHelper(binaryPath: string, log: (level: LogLevel, msg: string) => void): VisionHelper`
  - `interface VisionHelper { ocrImage(bytes: Uint8Array, mime?: string): Promise<string>; rasterizePdf(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]> }` (PNG bytes per page)
  - `createAppleVisionProvider(deps: { binaryPath: string; helper: VisionHelper; platform?: string; log: (level: LogLevel, msg: string) => void }): InferenceProvider` — id `'apple-vision'`, supports `['read']`.
- Tasks 9, 11, 15 consume `VisionHelper`; Task 15 consumes the provider factory.

- [ ] **Step 1: Port the helper driver**

Copy `/Users/edjafarov/work/kiagent-ref/src/main/inference/vision-helper.ts` to `src/main/providers/apple-vision/vision-helper.ts`. Keep its spawn/JSON protocol and 120 s timeout intact. Adaptations (the ONLY changes):
- Replace the legacy logger import with a `log: (level, msg) => void` constructor parameter.
- Export the surface as `makeVisionHelper(binaryPath, log): VisionHelper` with the two methods above. The ref splits OCR (`ocr/native-vision.ts`) and rasterization (`rasterize/core-graphics.ts`) into wrapper classes around the same helper — collapse both call paths into these two methods, copying their request payloads verbatim (read all three ref files first; the helper takes file paths, so write `bytes` to a temp file via `tmp-promise` exactly as the ref wrappers do, and clean up in `finally`).
- Types come from `@shared/contracts` (`LogLevel`).

- [ ] **Step 2: Write the failing provider test**

```ts
import type { InferenceProvider } from '@shared/contracts';

import { createAppleVisionProvider } from '../provider';

const noop = () => {};
const fakeHelper = {
  ocrImage: jest.fn(async () => 'ocr result'),
  rasterizePdf: jest.fn(async () => []),
};

describe('apple-vision provider', () => {
  it('is ready on darwin when the binary exists', () => {
    const p = createAppleVisionProvider({
      binaryPath: __filename, // any existing file
      helper: fakeHelper,
      platform: 'darwin',
      log: noop,
    });
    expect(p.id).toBe('apple-vision');
    expect(p.supports).toEqual(['read']);
    expect(p.status()).toBe('ready');
  });

  it('is unsupported off darwin, error when binary missing', () => {
    expect(
      createAppleVisionProvider({ binaryPath: __filename, helper: fakeHelper, platform: 'linux', log: noop }).status(),
    ).toBe('unsupported');
    const missing = createAppleVisionProvider({
      binaryPath: '/no/such/kia-vision',
      helper: fakeHelper,
      platform: 'darwin',
      log: noop,
    });
    expect(missing.status()).toMatchObject({ error: expect.stringContaining('vendor:inference') });
  });

  it('handles read and rejects other kinds', async () => {
    const p = createAppleVisionProvider({
      binaryPath: __filename,
      helper: fakeHelper,
      platform: 'darwin',
      log: noop,
    });
    await expect(
      p.handle({ kind: 'read', payload: { image: new Uint8Array([1]), mime: 'image/png' }, lane: 'background' }),
    ).resolves.toBe('ocr result');
    await expect(p.handle({ kind: 'see', payload: {}, lane: 'background' })).rejects.toThrow(/read/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails, implement provider.ts**

Run: `npx jest src/main/providers/apple-vision` → FAIL. Then:

```ts
import fs from 'fs';

import type { InferenceProvider, LogLevel } from '@shared/contracts';

import type { VisionHelper } from './vision-helper';

export function createAppleVisionProvider(deps: {
  binaryPath: string;
  helper: VisionHelper;
  platform?: string;
  log: (level: LogLevel, msg: string) => void;
}): InferenceProvider {
  const platform = deps.platform ?? process.platform;
  return {
    id: 'apple-vision',
    supports: ['read'],
    status() {
      if (platform !== 'darwin') return 'unsupported';
      if (!fs.existsSync(deps.binaryPath)) {
        return { error: 'kia-vision helper missing — run: npm run vendor:inference' };
      }
      return 'ready';
    },
    async handle(req) {
      if (req.kind !== 'read') {
        throw new Error(`apple-vision only supports 'read' (got '${req.kind}')`);
      }
      const { image, mime } = req.payload as { image: Uint8Array; mime?: string };
      return deps.helper.ocrImage(image, mime);
    },
  };
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx jest src/main/providers/apple-vision && npx tsc --noEmit`

```bash
git add src/main/providers/apple-vision
git commit -m "feat(providers): apple-vision — native OCR via bundled kia-vision helper"
```

---

### Task 9: Rasterizer (pdfium WASM port + platform pick)

**Files:**
- Create: `src/main/workers/vision/rasterize.ts`
- Test: `src/main/workers/vision/__tests__/rasterize.test.ts`
- Reference: `/Users/edjafarov/work/kiagent-ref/src/main/inference/rasterize/wasm.ts`

**Interfaces:**
- Consumes: `VisionHelper` (Task 8).
- Produces: `interface Rasterizer { pdfToPngs(bytes: Uint8Array, maxPages: number): Promise<Uint8Array[]> }`; `pickRasterizer(helper: VisionHelper | null, platform?: string): Rasterizer`; `wasmRasterizer(): Rasterizer`. Task 11 consumes `Rasterizer`; Task 15 calls `pickRasterizer`.

- [ ] **Step 1: Port + implement**

Port the body of ref `rasterize/wasm.ts` into `wasmRasterizer()` — dynamic `import('@hyzyla/pdfium')`, render each page at scale 2, BGRA→RGBA byte swap, PNG-encode with `pngjs`, stop at `maxPages`. Keep the ref's buffer handling verbatim. Then:

```ts
export function pickRasterizer(helper: VisionHelper | null, platform = process.platform): Rasterizer {
  if (platform === 'darwin' && helper) {
    return { pdfToPngs: (bytes, maxPages) => helper.rasterizePdf(bytes, maxPages) };
  }
  return wasmRasterizer();
}
```

- [ ] **Step 2: Write tests (mocked pdfium)**

```ts
jest.mock('@hyzyla/pdfium', () => ({ /* copy the minimal shape the port calls:
  init/loadDocument/pages iterator returning render({scale}) → {data(BGRA), width, height} —
  mirror the EXACT api surface used in your ported wasm.ts */ }));
```

Test cases:
- `pdfToPngs` respects `maxPages` (mock a 3-page doc, ask for 2, expect 2 PNGs).
- BGRA→RGBA: mock one 1×1 page with bytes `[1, 2, 3, 4]` (BGRA), decode the returned PNG with `pngjs` and expect pixel `[3, 2, 1, 4]` (RGBA).
- `pickRasterizer(helper, 'darwin')` delegates to `helper.rasterizePdf`; `pickRasterizer(null, 'darwin')` and `pickRasterizer(helper, 'linux')` return the wasm one.

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx jest src/main/workers/vision && npx tsc --noEmit`

```bash
git add src/main/workers/vision
git commit -m "feat(vision): pdf rasterizer — CoreGraphics on mac, pdfium wasm fallback"
```

---

### Task 10: classify + merge (pure helpers)

**Files:**
- Create: `src/main/workers/vision/classify.ts`
- Create: `src/main/workers/vision/merge.ts`
- Test: `src/main/workers/vision/__tests__/classify.test.ts`, `__tests__/merge.test.ts`
- Reference: ref `src/main/inference/classify.ts`, `src/main/inference/merge.ts`, ref `src/main/inference/vlm.ts` (the default indexing prompt constant)

**Interfaces:**
- Consumes: `Document` from contracts.
- Produces (Task 11 uses all of these):
  - `classifyDocument(doc: Document): 'candidate' | 'skip'`
  - `isPdfDoc(doc: Document): boolean`
  - constants `OCR_SUFFICIENT_CHARS = 200`, `MAX_IMAGE_BYTES = 20 * 1024 * 1024`, `MAX_PDF_BYTES = 50 * 1024 * 1024`, `MAX_PAGES = 20`
  - `mergeExtraction(pages: PageResult[]): string` with `interface PageResult { ocrText?: string; description?: string }`
  - `INDEXING_PROMPT: string` (copy the retrieval-oriented default prompt string verbatim from ref `vlm.ts` — the "indexing a personal document archive for search" constant)

- [ ] **Step 1: Write failing tests**

`classify.test.ts` (build minimal `Document` literals with `as Document`):

```ts
const base = {
  id: 'd', accountId: 'a', externalId: 'x', type: 'attachment', title: 'scan.pdf',
  markdown: null, metadata: { mime: 'application/pdf', sizeBytes: 50_000 },
  createdAt: null, parentId: null, contentHash: 'h', seq: 1, archivedAt: null,
  languages: [], ingestedAt: '2026-01-01', updatedAt: '2026-01-01',
} as Document;

it.each([
  ['pdf attachment, no markdown', base, 'candidate'],
  ['already enriched', { ...base, metadata: { ...base.metadata, extraction: {} } }, 'skip'],
  ['has real markdown', { ...base, markdown: 'plenty of extracted text here' }, 'skip'],
  ['thin markdown still candidate', { ...base, markdown: 'short' }, 'candidate'],
  ['archived', { ...base, archivedAt: '2026-01-01' }, 'skip'],
  ['wrong type', { ...base, type: 'email.thread' }, 'skip'],
  ['tiny image', { ...base, metadata: { mime: 'image/png', sizeBytes: 500 } }, 'skip'],
  ['image by extension', { ...base, title: 'photo.HEIC', metadata: { filename: 'photo.HEIC', sizeBytes: 90_000 } }, 'candidate'],
  ['non-visual mime', { ...base, metadata: { mime: 'application/zip', filename: 'a.zip' } }, 'skip'],
])('%s → %s', (_n, doc, want) => expect(classifyDocument(doc as Document)).toBe(want));
```

`merge.test.ts`:

```ts
it('single page: sections without page markers', () => {
  expect(mergeExtraction([{ ocrText: 'hello world' }])).toBe('**Text content (OCR):**\n\nhello world');
});
it('multi page: --- page N --- headers, description + ocr', () => {
  const out = mergeExtraction([
    { ocrText: 'p1 text', description: 'a chart' },
    { description: 'a photo' },
  ]);
  expect(out).toContain('--- page 1 ---');
  expect(out).toContain('**Description:** a chart');
  expect(out).toContain('**Text content (OCR):**\n\np1 text');
  expect(out).toContain('--- page 2 ---');
});
it('caps at 1MB', () => {
  const out = mergeExtraction([{ ocrText: 'x'.repeat(2_000_000) }]);
  expect(out.length).toBeLessThanOrEqual(1_000_000);
});
it('empty pages produce empty string', () => {
  expect(mergeExtraction([{}, { ocrText: '   ' }])).toBe('');
});
```

- [ ] **Step 2: Run to verify fail, then implement**

`classify.ts`:

```ts
import type { Document } from '@shared/contracts';

const VISUAL_EXT_RE = /\.(pdf|png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;
const TINY_IMAGE_BYTES = 8 * 1024;
export const OCR_SUFFICIENT_CHARS = 200;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 20;

interface VisualMeta {
  mime?: string;
  filename?: string;
  sizeBytes?: number;
  extraction?: unknown;
}

export function isPdfDoc(doc: Document): boolean {
  const meta = doc.metadata as VisualMeta;
  const name = meta.filename ?? doc.title ?? '';
  return meta.mime === 'application/pdf' || /\.pdf$/i.test(name);
}

export function classifyDocument(doc: Document): 'candidate' | 'skip' {
  if (doc.archivedAt) return 'skip';
  if (doc.type !== 'attachment' && doc.type !== 'file') return 'skip';
  const meta = doc.metadata as VisualMeta;
  if (meta.extraction != null) return 'skip'; // already enriched
  const name = meta.filename ?? doc.title ?? '';
  const pdf = isPdfDoc(doc);
  const image = (meta.mime ?? '').startsWith('image/') || (!pdf && VISUAL_EXT_RE.test(name) && !/\.pdf$/i.test(name));
  if (!pdf && !image) return 'skip';
  if (image && (meta.sizeBytes ?? Number.MAX_SAFE_INTEGER) < TINY_IMAGE_BYTES) return 'skip';
  if ((doc.markdown ?? '').trim().length >= 16) return 'skip'; // has real text already
  return 'candidate';
}
```

`merge.ts`:

```ts
export interface PageResult {
  ocrText?: string;
  description?: string;
}

const MAX_MERGED_CHARS = 1_000_000;

// INDEXING_PROMPT: open /Users/edjafarov/work/kiagent-ref/src/main/inference/vlm.ts,
// find the default prompt constant (~line 30, the retrieval-oriented "You are
// indexing a personal document archive for search… Do not transcribe the full
// text verbatim" string) and copy that string LITERAL here verbatim:
export const INDEXING_PROMPT = '<verbatim string from ref vlm.ts>';

export function mergeExtraction(pages: PageResult[]): string {
  const multi = pages.length > 1;
  const parts: string[] = [];
  pages.forEach((p, i) => {
    const sec: string[] = [];
    const description = p.description?.trim();
    const ocr = p.ocrText?.trim();
    if (description) sec.push(`**Description:** ${description}`);
    if (ocr) sec.push(`**Text content (OCR):**\n\n${ocr}`);
    if (sec.length === 0) return;
    parts.push(multi ? [`--- page ${i + 1} ---`, ...sec].join('\n\n') : sec.join('\n\n'));
  });
  return parts.join('\n\n').slice(0, MAX_MERGED_CHARS);
}
```

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx jest src/main/workers/vision && npx tsc --noEmit`

```bash
git add src/main/workers/vision
git commit -m "feat(vision): classify + merge helpers (ported heuristics)"
```

---

### Task 11: The vision worker

**Files:**
- Create: `src/main/workers/vision/vision-worker.ts`
- Test: `src/main/workers/vision/__tests__/vision-worker.test.ts`

**Interfaces:**
- Consumes: `classifyDocument`, `isPdfDoc`, constants (Task 10), `mergeExtraction`, `INDEXING_PROMPT`, `Rasterizer` (Task 9), `WorkerSession` sugar (Task 3).
- Produces: `createVisionWorker(deps: { rasterizer: Rasterizer; laneOpen(): boolean }): Worker` — name `'vision'`, version `1` (consumer id `worker:vision:v1`), `schedule: { every: '30m' }`. Task 15 attaches it.

- [ ] **Step 1: Write failing tests**

Fake session + rasterizer; drive `work()` directly:

```ts
function fakeSession(over: Partial<WorkerSession> = {}): WorkerSession & { enriched: EnrichInput[] } {
  const enriched: EnrichInput[] = [];
  return {
    enriched,
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => 'a description of the page',
    read: async () => 'plenty of ocr text '.repeat(20), // > 200 chars
    fetchBytes: async () => new Uint8Array(100_000),
    emit: () => {},
    enrich: (e) => enriched.push(e),
    log: () => {},
    ...over,
  };
}
const rasterizer = { pdfToPngs: jest.fn(async () => [new Uint8Array([1]), new Uint8Array([2])]) };
const change = (doc: Partial<Document>) => ({ seq: 1, kind: 'document', document: { ...baseDoc, ...doc } } as Change);
```

(`baseDoc` = the candidate PDF-attachment literal from Task 10's test.) Cases:

1. **OCR-sufficient PDF → done, enrich with per-page OCR, no `see` call**: worker with `laneOpen: () => true`; expect `'done'`, `session.enriched[0].markdown` contains `--- page 1 ---` and the OCR text, `metadata.extraction.engine === 'local-ocr'`, `see` never called (spy).
2. **Thin OCR + see available → done with descriptions**: `read: async () => 'thin'`; expect `'done'`, markdown contains `**Description:**`, engine `'local-ocr+vlm'`.
3. **Thin OCR + see throws (no provider) → defer**: `see: async () => { throw new Error('no inference provider'); }`; expect `'defer'`, no enrich.
4. **read throws (no OCR provider) → straight to see**: `read` rejects, `see` resolves; expect `'done'` with description-only markdown.
5. **Lane closed → defer immediately**: `laneOpen: () => false`; expect `'defer'`, `fetchBytes` not called.
6. **fetchBytes null → skip**; **oversized → skip** (`fetchBytes` returns `new Uint8Array(MAX_PDF_BYTES + 1)`).
7. **Image doc**: metadata `{mime: 'image/png', sizeBytes: 50_000}` — rasterizer NOT called, single page.
8. **matches()**: candidate document change → true; `kind: 'account'` change → false.

- [ ] **Step 2: Run to verify fail, then implement**

```ts
import type { Change, Document, Worker, WorkerSession, WorkOutcome } from '@shared/contracts';

import {
  classifyDocument,
  isPdfDoc,
  MAX_IMAGE_BYTES,
  MAX_PAGES,
  MAX_PDF_BYTES,
  OCR_SUFFICIENT_CHARS,
} from './classify';
import { INDEXING_PROMPT, mergeExtraction } from './merge';
import type { PageResult } from './merge';
import type { Rasterizer } from './rasterize';

/**
 * The two-pass vision worker. Pass 1 = OCR via `read` (free/native where
 * available); a text-rich result enriches immediately. Text-poor documents
 * fall through to pass 2 = VLM `see`; when no see-provider is ready the
 * change DEFERS and the scheduled re-drive retries it — at-least-once, so
 * a re-driven change simply re-runs both passes.
 */
export function createVisionWorker(deps: {
  rasterizer: Rasterizer;
  laneOpen(): boolean;
}): Worker {
  return {
    name: 'vision',
    version: 1,
    schedule: { every: '30m' }, // deferred re-drive cadence; the live tail always runs
    matches: (change: Change) =>
      change.kind === 'document' && classifyDocument(change.document) === 'candidate',

    async work(change: Change, session: WorkerSession): Promise<WorkOutcome> {
      if (change.kind !== 'document') return 'skip';
      const doc = change.document;
      // Outside the processing window: park instead of blocking on the lane
      // gate — a parked ledger row is free, a blocked work() stalls the tail.
      if (!deps.laneOpen()) return 'defer';

      const pdf = isPdfDoc(doc);
      const bytes = await session.fetchBytes(doc);
      if (!bytes) return 'skip'; // source can't serve bytes — terminal
      if (bytes.length > (pdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) return 'skip';

      const mime = (doc.metadata as { mime?: string }).mime;
      const pages = pdf ? await deps.rasterizer.pdfToPngs(bytes, MAX_PAGES) : [bytes];
      const pageMime = pdf ? 'image/png' : mime;

      // Pass 1 — OCR.
      const ocr: Array<string | undefined> = [];
      let ocrFailed = false;
      for (const page of pages) {
        try {
          ocr.push(await session.read(page, { mime: pageMime }));
        } catch {
          ocrFailed = true; // no read provider (non-mac) or helper down
          break;
        }
      }
      const ocrChars = ocr.join('').replace(/\s+/g, '').length;
      if (!ocrFailed && ocrChars >= OCR_SUFFICIENT_CHARS) {
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(pages.map((_, i): PageResult => ({ ocrText: ocr[i] }))),
          metadata: { extraction: { engine: 'local-ocr', at: new Date().toISOString() } },
        });
        return 'done';
      }

      // Pass 2 — VLM describe (only reachable when a see-provider is ready).
      try {
        const results: PageResult[] = [];
        for (let i = 0; i < pages.length; i += 1) {
          const description = await session.see(pages[i], INDEXING_PROMPT, { mime: pageMime });
          results.push({ ocrText: ocr[i], description });
        }
        session.enrich({
          documentId: doc.id,
          markdown: mergeExtraction(results),
          metadata: { extraction: { engine: 'local-ocr+vlm', at: new Date().toISOString() } },
        });
        return 'done';
      } catch {
        return 'defer'; // model not installed/ready — the re-drive picks it up
      }
    },
  };
}
```

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx jest src/main/workers/vision && npx tsc --noEmit`

```bash
git add src/main/workers/vision
git commit -m "feat(workers): two-pass vision worker — OCR now, VLM on the re-drive"
```

---

### Task 12: local-llm — capability, backend, model catalog (ports)

**Files:**
- Create: `src/main/providers/local-llm/capability.ts`, `backend.ts`, `models.ts`
- Test: `src/main/providers/local-llm/__tests__/models.test.ts`
- Reference: ref `src/main/inference/runtime/capability.ts`, `backend.ts`, `models.ts`

**Interfaces:**
- Produces (Tasks 13, 14 consume):
  - `checkCapability(probes?: HostProbes): { ok: boolean; slow?: boolean; reason?: string }` with `HostProbes { platform: string; arch: string; totalMemBytes: number }`
  - `detectHostBackend(opts?: { platform?: string; listDevices?(): Promise<string> }): Promise<BackendInfo>` with `BackendInfo { accel: 'metal' | 'vulkan' | 'cpu'; capacityBytes: number }`
  - `selectCuratedModel(backend: BackendInfo): ModelDescriptor`; `resolveModelOverride(id: string): ModelDescriptor | null`; `modelDir(dataModelsDir: string, id: string): string`
  - `ModelDescriptor { id, label, files: Array<{ name, url, sizeBytes, sha256 }> }` — exact catalog copied from ref (`CURATED_MODEL` Gemma-4-12B ≥48 GB, `E4B_MODEL` ≥24 GB, `E2B_MODEL` floor/CPU, `GLM_OCR_MODEL` exported but not in tiers).

- [ ] **Step 1: Port the three files**

Copy from the ref, adaptations only:
- Delete the stale "16 GB capability gate" comments (ref `models.ts:163` — no such gate exists; the only floor is 8 GB CPU-only in `capability.ts`).
- `backend.ts`: keep the darwin→metal short-circuit and CPU fallback; keep the Vulkan parser function but have `detectHostBackend` take the injectable `listDevices` (default: return `''` → cpu path) — the bundled `llama-server --list-devices` spawn wiring is phase C; note that in a comment.
- `models.ts`: catalog verbatim (ids, HF repo/rev URLs, sizes, sha256). `modelDir(dataModelsDir, id)` = `path.join(dataModelsDir, id)` (greenfield keeps models under `<userData>/data/models/`).
- Replace any legacy logger/prefs imports with parameters; these three files must be dependency-free (pure + `os`).

- [ ] **Step 2: Write tests**

```ts
const G = 1024 ** 3;
it.each([
  ['metal 64GB → 12B', { accel: 'metal', capacityBytes: 64 * G }, 'gemma-4-12b-it-Q4_K_M'],
  ['metal 32GB → E4B', { accel: 'metal', capacityBytes: 32 * G }, 'gemma-4-E4B-it-Q4_K_M'],
  ['metal 16GB → E2B', { accel: 'metal', capacityBytes: 16 * G }, 'gemma-4-E2B-it-Q4_K_M'],
  ['vulkan 8GB VRAM → E2B', { accel: 'vulkan', capacityBytes: 8 * G }, 'gemma-4-E2B-it-Q4_K_M'],
  ['cpu 128GB still E2B', { accel: 'cpu', capacityBytes: 128 * G }, 'gemma-4-E2B-it-Q4_K_M'],
])('%s', (_n, backend, want) => expect(selectCuratedModel(backend as BackendInfo).id).toBe(want));

it('capability: cpu-only under 8GB fails, gpu always passes', () => {
  expect(checkCapability({ platform: 'linux', arch: 'x64', totalMemBytes: 4 * G }).ok).toBe(false);
  expect(checkCapability({ platform: 'darwin', arch: 'arm64', totalMemBytes: 16 * G }).ok).toBe(true);
});

it('override resolves catalog ids, auto/unknown → null', () => {
  expect(resolveModelOverride('gemma-4-E4B-it-Q4_K_M')?.id).toBe('gemma-4-E4B-it-Q4_K_M');
  expect(resolveModelOverride('auto')).toBeNull();
  expect(resolveModelOverride('bogus')).toBeNull();
});
```

Match `checkCapability`'s exact return semantics to the ported code (the ref flags CPU hosts `slow: true` but passing — preserve that).

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx jest src/main/providers/local-llm && npx tsc --noEmit`

```bash
git add src/main/providers/local-llm
git commit -m "feat(local-llm): capability gate, backend detect, curated model catalog (ported)"
```

---

### Task 13: local-llm — downloader (port)

**Files:**
- Create: `src/main/providers/local-llm/downloader.ts`
- Test: `src/main/providers/local-llm/__tests__/downloader.test.ts`
- Reference: ref `src/main/inference/runtime/downloader.ts`

**Interfaces:**
- Consumes: `ModelDescriptor` (Task 12).
- Produces (Task 14 consumes):
  - `downloadModel(model: ModelDescriptor, destDir: string, opts: { onProgress?(receivedBytes: number, totalBytes: number): void; signal?: AbortSignal; fetchImpl?: typeof fetch; freeDiskBytes?(dir: string): Promise<number> }): Promise<void>`
  - `modelFilesPresent(model: ModelDescriptor, destDir: string): boolean`
  - `class DownloadError extends Error { code: 'disk_full' | 'sha_mismatch' | 'http' | 'aborted' }`

- [ ] **Step 1: Port**

Copy ref `downloader.ts` wholesale — keep the `.part` + `Range` resume, 206/200/416 handling, the chunk-copy generator (multi-GB fetch corruption workaround), streamed AND on-disk SHA-256, size gate before hashing, atomic rename, and the 1.5× free-disk preflight. Adaptations: `fetchImpl` (default `globalThis.fetch`) and `freeDiskBytes` (default via `fs.promises.statfs` — check what the ref uses and keep it as the default implementation) become injectable through `opts`; error type surface normalized to the `DownloadError` codes above (the ref already has `DownloadError('disk_full')` — preserve its codes, add ones it lacks).

- [ ] **Step 2: Write tests**

Use a tmp `destDir` per test and a fake `fetchImpl` returning `Response` objects with `ReadableStream` bodies built from `Uint8Array`s; compute expected sha256 with `node:crypto`. Model fixture: one file, `sizeBytes` = payload length, `sha256` = real hash.

1. **Happy path**: full body, 200 → file exists at final name, no `.part`, progress reached (total, total).
2. **Resume**: pre-write the first half as `<name>.part`; fake fetch asserts `Range: bytes=<half>-`, replies 206 with the second half → final file complete + hash-verified.
3. **sha mismatch**: correct size, wrong bytes → rejects with `DownloadError` code `sha_mismatch`, `.part` deleted.
4. **Disk preflight**: `freeDiskBytes: async () => model.files[0].sizeBytes` (< 1.5×) → rejects `disk_full`, no fetch call.
5. **Idempotent**: run twice; second run must not call fetch (correctly-sized final file skipped).
6. **`modelFilesPresent`** true/false by exact size match.

- [ ] **Step 3: Run tests, typecheck, commit**

Run: `npx jest src/main/providers/local-llm/__tests__/downloader.test.ts && npx tsc --noEmit`

```bash
git add src/main/providers/local-llm
git commit -m "feat(local-llm): resumable checksummed model downloader (ported)"
```

---

### Task 14: local-llm — server supervisor, HTTP api, provider facade

**Files:**
- Create: `src/main/providers/local-llm/server.ts` (ported), `api.ts` (ported), `provider.ts`
- Test: `src/main/providers/local-llm/__tests__/provider.test.ts`
- Reference: ref `src/main/inference/runtime/server.ts`, ref `src/main/inference/vlm.ts`

**Interfaces:**
- Consumes: Tasks 12–13 exports; `Prefs` (Task 7).
- Produces (Tasks 15, 16 consume):
  - `interface LocalLlmProvider extends InferenceProvider { ensureInstalled(): void; cancelInstall(): Promise<void>; selectedModel(): Promise<ModelDescriptor>; installedModelIds(): string[] }`
  - `createLocalLlmProvider(deps: { llamaBinaryPath: string; modelsDir: string; prefs: Prefs; log(level: LogLevel, msg: string): void; detect?(): Promise<BackendInfo>; download?: typeof downloadModel; makeServer?(args: { binaryPath: string; modelPath: string; mmprojPath: string; gpuLayers: number; log(level: LogLevel, msg: string): void }): ServerLike; idleStopMs?: number }): LocalLlmProvider`
  - `interface ServerLike { start(): Promise<void>; stop(): Promise<void>; baseUrl(): string }`

- [ ] **Step 1: Port server.ts and api.ts**

`server.ts`: copy ref `LlamaServer` — free-port pick, spawn, `/health` poll, crash respawn with backoff (250 ms → 30 s), SIGTERM→SIGKILL stop, line-forwarded stdout/stderr into `log`. Keep launch args verbatim: `-m <model> --mmproj <mmproj> --host 127.0.0.1 --port <p> -c 4096 -ngl <999|0> --cache-ram 0`. Make it implement `ServerLike`.

`api.ts`: from ref `vlm.ts`, port `describeImage(baseUrl, image: Uint8Array, prompt: string)` (POST `/v1/chat/completions`, image as base64 data-url content part, temp 0.1, max_tokens 1500, 180 s timeout) and `chatText(baseUrl, prompt, opts?: { maxTokens?: number })`.

- [ ] **Step 2: Write failing provider tests**

All with injected fakes; jest fake timers for idle-stop.

```ts
function makeDeps(over = {}) {
  const server = { start: jest.fn(async () => {}), stop: jest.fn(async () => {}), baseUrl: () => 'http://x' };
  return {
    server,
    deps: {
      llamaBinaryPath: '/bin/llama-server',
      modelsDir: tmpDir,
      prefs: fakePrefs({ models: { override: 'auto', autoInstall: true } }),
      log: () => {},
      detect: async () => ({ accel: 'metal', capacityBytes: 64 * 1024 ** 3 }),
      download: jest.fn(async (_m, _d, opts) => { opts.onProgress?.(50, 100); }),
      makeServer: () => server,
      idleStopMs: 1000,
      ...over,
    },
  };
}
```

1. **standby before install**: `status()` is `'standby'` when no files on disk.
2. **ensureInstalled downloads the tier model**: after `ensureInstalled()` resolves (expose the in-flight promise or poll status), `download` called with the 12B descriptor (64 GB metal); during download `status()` was `{downloading: {pct: 50}}`; after (fake `modelFilesPresent` → true, e.g. by touching correctly-named files or injecting the check — prefer injecting `filesPresent?: typeof modelFilesPresent` in deps for testability) `status()` is `'ready'`.
3. **respects autoInstall=false**: prefs with `autoInstall: false` → `ensureInstalled()` is a no-op (no download call). `ensureInstalled()` after `prefs.patch({models:{autoInstall:true,…}})` downloads.
4. **unsupported hardware**: `detect` returning cpu + a `checkCapability` failure (inject probes via deps or a `capability?` hook) → `status()` `'unsupported'`, ensureInstalled no-op.
5. **download error surfaces**: `download` rejects → `status()` `{error: …}`; a later `ensureInstalled()` retries (downloader resumes).
6. **cancelInstall aborts**: `download` that never resolves until aborted; `cancelInstall()` → status back to `'standby'`.
7. **lazy server + idle stop**: with ready status, `handle({kind:'complete',…})` starts the server once (second call: still one `start`), and after `idleStopMs` of no requests (advance fake timers) `stop()` is called while `status()` stays `'ready'`.
8. **handle routes kinds**: `'complete'` → `chatText`, `'see'` → `describeImage` (mock `api.ts` with `jest.mock`), `'read'` → rejects (not supported).

- [ ] **Step 3: Implement provider.ts**

```ts
import fs from 'fs';
import path from 'path';

import type { InferenceProvider, LogLevel, Prefs, ProviderStatus } from '@shared/contracts';

import { chatText, describeImage } from './api';
import { checkCapability, readHostProbes } from './capability';
import { detectHostBackend } from './backend';
import type { BackendInfo } from './backend';
import { downloadModel, modelFilesPresent } from './downloader';
import { modelDir, resolveModelOverride, selectCuratedModel } from './models';
import type { ModelDescriptor } from './models';
import { LlamaServer } from './server';

export interface ServerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  baseUrl(): string;
}

export interface LocalLlmProvider extends InferenceProvider {
  ensureInstalled(): void;
  cancelInstall(): Promise<void>;
  selectedModel(): Promise<ModelDescriptor>;
  installedModelIds(): string[];
}

const DEFAULT_IDLE_STOP_MS = 10 * 60_000;

export function createLocalLlmProvider(deps: {
  llamaBinaryPath: string;
  modelsDir: string;
  prefs: Prefs;
  log(level: LogLevel, msg: string): void;
  detect?(): Promise<BackendInfo>;
  download?: typeof downloadModel;
  filesPresent?: typeof modelFilesPresent;
  makeServer?(args: {
    binaryPath: string;
    modelPath: string;
    mmprojPath: string;
    gpuLayers: number;
    log(level: LogLevel, msg: string): void;
  }): ServerLike;
  idleStopMs?: number;
}): LocalLlmProvider {
  const detect = deps.detect ?? (() => detectHostBackend());
  const download = deps.download ?? downloadModel;
  const filesPresent = deps.filesPresent ?? modelFilesPresent;
  const makeServer =
    deps.makeServer ?? ((args) => new LlamaServer(args) as unknown as ServerLike);
  const idleStopMs = deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS;

  const capability = checkCapability(readHostProbes());
  let backend: BackendInfo | null = null; // detected once, lazily
  let installedModel: ModelDescriptor | null = null; // model whose files are on disk
  let downloadPct: number | null = null;
  let lastError: string | null = null;
  let installing: AbortController | null = null;
  let server: ServerLike | null = null;
  let serverStarting: Promise<void> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedModel = async (): Promise<ModelDescriptor> => {
    const override = resolveModelOverride(deps.prefs.get().models.override);
    if (override) return override;
    if (!backend) backend = await detect();
    return selectCuratedModel(backend);
  };

  /** Sync best-effort check: is the currently-selected model on disk?
   *  (Override reads are sync; the auto tier needs `backend`, detected on
   *  the first ensureInstalled/handle — until then, scan the models dir.) */
  const findInstalled = (): ModelDescriptor | null => {
    if (installedModel && filesPresent(installedModel, modelDir(deps.modelsDir, installedModel.id))) {
      return installedModel;
    }
    return null;
  };

  const stopServer = async (): Promise<void> => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const s = server;
    server = null;
    serverStarting = null;
    if (s) await s.stop().catch((err) => deps.log('warn', `llama stop: ${String(err)}`));
  };

  const touchIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      deps.log('info', 'local-llm idle — releasing model RAM');
      void stopServer();
    }, idleStopMs);
  };

  const ensureInstalled = (): void => {
    if (installing) return;
    if (!capability.ok) return;
    if (!deps.prefs.get().models.autoInstall) return;
    if (findInstalled()) return;
    const abort = new AbortController();
    installing = abort;
    void (async () => {
      try {
        const model = await selectedModel();
        const dest = modelDir(deps.modelsDir, model.id);
        if (!filesPresent(model, dest)) {
          deps.log('info', `downloading ${model.id} (${model.files.reduce((n, f) => n + f.sizeBytes, 0)} bytes)`);
          downloadPct = 0;
          lastError = null;
          await download(model, dest, {
            signal: abort.signal,
            onProgress: (received, total) => {
              downloadPct = total > 0 ? (received / total) * 100 : 0;
            },
          });
        }
        installedModel = model;
        deps.log('info', `${model.id} ready`);
      } catch (err) {
        if (!abort.signal.aborted) {
          lastError = String(err instanceof Error ? err.message : err);
          deps.log('warn', `model install failed: ${lastError}`);
        }
      } finally {
        downloadPct = null;
        installing = null;
      }
    })();
  };

  const ensureServer = async (model: ModelDescriptor): Promise<ServerLike> => {
    if (server) {
      await serverStarting;
      return server;
    }
    const dir = modelDir(deps.modelsDir, model.id);
    const gguf = model.files.find((f) => !f.name.startsWith('mmproj'))!;
    const mmproj = model.files.find((f) => f.name.startsWith('mmproj'))!;
    if (!backend) backend = await detect();
    server = makeServer({
      binaryPath: deps.llamaBinaryPath,
      modelPath: path.join(dir, gguf.name),
      mmprojPath: path.join(dir, mmproj.name),
      gpuLayers: backend.accel === 'cpu' ? 0 : 999,
      log: deps.log,
    });
    serverStarting = server.start();
    await serverStarting;
    return server;
  };

  return {
    id: 'local-llm',
    supports: ['complete', 'see'],
    status(): ProviderStatus {
      if (!capability.ok) return 'unsupported';
      if (downloadPct !== null) return { downloading: { pct: downloadPct } };
      if (lastError) return { error: lastError };
      if (findInstalled()) return 'ready';
      return 'standby';
    },
    async handle(req) {
      const model = findInstalled();
      if (!model) throw new Error(`local-llm not ready (status: ${JSON.stringify(this.status())})`);
      const s = await ensureServer(model);
      touchIdle();
      if (req.kind === 'complete') {
        const { prompt, maxTokens } = req.payload as { prompt: string; maxTokens?: number };
        return chatText(s.baseUrl(), prompt, { maxTokens });
      }
      if (req.kind === 'see') {
        const { image, prompt } = req.payload as { image: Uint8Array; prompt: string };
        return describeImage(s.baseUrl(), image, prompt);
      }
      throw new Error(`local-llm does not support '${req.kind}'`);
    },
    ensureInstalled,
    async cancelInstall() {
      installing?.abort();
      installing = null;
      downloadPct = null;
      lastError = null;
    },
    selectedModel,
    installedModelIds() {
      if (!fs.existsSync(deps.modelsDir)) return [];
      return fs.readdirSync(deps.modelsDir).filter((id) => {
        const m = resolveModelOverride(id);
        return m !== null && filesPresent(m, modelDir(deps.modelsDir, id));
      });
    },
  };
}
```

Two adjustments to make while wiring this to the ports: (1) `readHostProbes` must be exported from `capability.ts` (the ref exports it — keep that); (2) `findInstalled` starts null after a restart even when files exist — fix by seeding `installedModel` at construction: iterate the catalog tiers + override and set the first model whose files are present (add a small `seedInstalled()` called once at the bottom of the factory; test 2 covers the fresh-install path, add an assertion constructing a second provider over the same dir and expecting `'ready'`). Adapt `LlamaServer`'s constructor args to the ported class's actual shape — change the `makeServer` default lambda, not the `ServerLike` interface.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx jest src/main/providers/local-llm && npx tsc --noEmit`

```bash
git add src/main/providers/local-llm
git commit -m "feat(local-llm): provider facade — auto-install, lazy llama-server, idle stop"
```

---

### Task 15: Wiring — registration, auto-install trigger, IPC

**Files:**
- Create: `src/main/providers/index.ts`, `src/main/workers/index.ts`
- Modify: `src/main/main.ts` (boot sequence ~line 283; registerIpc ~lines 126, 260)
- Modify: `src/shared/ipc.ts` (Invokes + INVOKE_CHANNELS)
- Test: typecheck + existing suites (wiring is glue; behavior was tested in Tasks 8–14)

**Interfaces:**
- Consumes: everything above; `bootCore`/`backgroundLaneOpen` from `core/boot.ts`; `getAssetPath` in main.ts (~line 86).
- Produces: `registerBundledProviders(platform: CorePlatform, opts: { assetsDir: string; dataDir: string }): { localLlm: LocalLlmProvider; visionHelper: VisionHelper | null }`; `attachBundledWorkers(platform: CorePlatform, deps: { visionHelper: VisionHelper | null; localLlm: LocalLlmProvider }): Handle`; IPC `inference:install` / `inference:cancel` (both `{req: void; res: void}`).

- [ ] **Step 1: providers/index.ts**

```ts
import path from 'path';

import type { CorePlatform } from '../core/boot';

import { createAppleVisionProvider } from './apple-vision/provider';
import { makeVisionHelper } from './apple-vision/vision-helper';
import type { VisionHelper } from './apple-vision/vision-helper';
import { createLocalLlmProvider } from './local-llm/provider';
import type { LocalLlmProvider } from './local-llm/provider';

/** Mirrors registerBundledSources: main.ts calls this once after bootCore. */
export function registerBundledProviders(
  platform: CorePlatform,
  opts: { assetsDir: string; dataDir: string },
): { localLlm: LocalLlmProvider; visionHelper: VisionHelper | null } {
  const log = (scope: string) => (level: 'info' | 'warn' | 'error', msg: string) =>
    platform.logSink.log(scope, level, msg);

  const visionBinary = path.join(
    opts.assetsDir, 'vision', `${process.platform}-${process.arch}`, 'kia-vision',
  );
  const visionHelper =
    process.platform === 'darwin' ? makeVisionHelper(visionBinary, log('inference')) : null;
  if (visionHelper) {
    platform.inference.register(
      createAppleVisionProvider({ binaryPath: visionBinary, helper: visionHelper, log: log('inference') }),
    );
  }

  const llamaSlugDir = path.join(opts.assetsDir, 'llama'); // per-platform slug resolved inside
  const localLlm = createLocalLlmProvider({
    llamaBinaryPath: resolveLlamaBinary(llamaSlugDir), // port `llamaSlug` from ref catalog.ts:35
    modelsDir: path.join(opts.dataDir, 'models'),
    prefs: platform.prefs,
    log: log('inference'),
  });
  platform.inference.register(localLlm);
  return { localLlm, visionHelper };
}
```

Port `resolveLlamaBinary` from the ref's `catalog.ts` `llamaSlug` logic (darwin slug omits accel; binary name `llama-server`).

- [ ] **Step 2: workers/index.ts**

```ts
import type { Handle } from '@shared/contracts';

import { backgroundLaneOpen } from '../core/boot';
import type { CorePlatform } from '../core/boot';
import type { VisionHelper } from '../providers/apple-vision/vision-helper';
import type { LocalLlmProvider } from '../providers/local-llm/provider';
import { pickRasterizer } from './vision/rasterize';
import { createVisionWorker } from './vision/vision-worker';

const VISION_CONSUMER = 'worker:vision:v1';

export function attachBundledWorkers(
  platform: CorePlatform,
  deps: { visionHelper: VisionHelper | null; localLlm: LocalLlmProvider },
): Handle {
  const worker = createVisionWorker({
    rasterizer: pickRasterizer(deps.visionHelper),
    laneOpen: () => backgroundLaneOpen(platform),
  });
  const handle = platform.engine.attach(worker);
  // NOT boot.attachWorker: the re-drive job additionally (1) skips outside
  // the processing window and (2) triggers the model auto-install when
  // deferred vision work exists — the user-approved auto-download path.
  platform.scheduler.register(`worker:${worker.name}`, worker.schedule as { every: string }, async () => {
    if (!backgroundLaneOpen(platform)) return;
    if (platform.store.ledgerDeferred(VISION_CONSUMER).length === 0) return;
    deps.localLlm.ensureInstalled(); // no-op if installed/downloading/opted-out
    await platform.engine.rerunDeferred(worker);
  });
  return handle;
}
```

- [ ] **Step 3: main.ts + ipc.ts**

`src/shared/ipc.ts`: in `Invokes` after `inference:providers` add

```ts
  /** Start (or retry) the local model download; also re-enables autoInstall. */
  'inference:install': { req: void; res: void };
  /** Abort the download and disable autoInstall until re-enabled. */
  'inference:cancel': { req: void; res: void };
```

and append both names to `INVOKE_CHANNELS`.

`src/main/main.ts`:
- In the boot sequence after `bootCore` (~line 283) and next to `registerBundledSources`:

```ts
    const bundled = registerBundledProviders(p, {
      assetsDir: getAssetPath(),
      dataDir,
    });
    attachBundledWorkers(p, bundled);
```

(`getAssetPath()` with no segments returns the assets root — verify against its definition at ~line 86; store `bundled` where `registerIpc` can reach it, following how `broker`/`patchState` are passed today.)
- In `registerIpc`, next to the `inference:providers` handler (~line 260):

```ts
  handle('inference:install', async () => {
    await p.prefs.patch({ models: { ...p.prefs.get().models, autoInstall: true } });
    bundled.localLlm.ensureInstalled();
  });
  handle('inference:cancel', async () => {
    await bundled.localLlm.cancelInstall();
    await p.prefs.patch({ models: { ...p.prefs.get().models, autoInstall: false } });
  });
```

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck, full suite green. Then launch the dev app (`npm start`), open Settings → Local processing, and confirm the provider list shows `apple-vision` (Ready, if the helper binary is vendored — otherwise its error row) and `local-llm` (Standby). App logs show `provider registered: apple-vision` / `local-llm`.

```bash
git add src/main/providers/index.ts src/main/workers/index.ts src/main/main.ts src/shared/ipc.ts
git commit -m "feat(main): register bundled providers + vision worker, install/cancel IPC"
```

---

### Task 16: Settings UI — model row, cancel, override

**Files:**
- Modify: `src/renderer/screens/Settings/LocalProcessing.tsx`
- Test: `npx tsc --noEmit` + manual (repo has no renderer unit tests)

**Interfaces:**
- Consumes: `inference:providers` (supports now includes `'read'`), `inference:install`, `inference:cancel`, `prefs:patch` with `models`, `AppPrefs.models`.

- [ ] **Step 1: Implement**

In `LocalProcessing.tsx`:
1. Read `models` prefs: `const models = useAppState((s) => s.prefs.models);`
2. **Poll while downloading**: extend the existing `loadProviders` mount effect — when any provider's status is `{downloading}`, set a 2 s `setInterval` re-invoking `loadProviders`, cleared when none are downloading (and on unmount).
3. **Provider row actions** (inside `ProviderRowView` or beside it — pass `models` + a `refresh` callback down): for the `local-llm` row only —
   - status `standby` + `autoInstall`: caption `Downloads automatically when scanned documents need it.` plus a `Download now` ghost button → `invoke('inference:install')` then `refresh()`.
   - status `standby` + `!autoInstall`: caption `Automatic download is off.` + same `Download now` button.
   - status `downloading`: keep the existing progress bar, add `Cancel` ghost button → `invoke('inference:cancel')` then `refresh()`.
   - status `{error}`: existing error detail + `Retry` button → `invoke('inference:install')`.
4. **Model override** (new pref-row in the Settings section, after Window): a `<select>` with `Auto (picked for this hardware)` + the three Gemma tier labels (`Gemma 4 12B (4-bit)` / `Gemma 4 E4B (4-bit)` / `Gemma 4 E2B (4-bit)`, values = catalog ids). On change: `invoke('prefs:patch', { models: { ...models, override: value } })`. Hardcode the three id/label pairs in a local `MODEL_OPTIONS` const (the renderer cannot import main-process catalog code).
5. Replace the empty-state copy `Installing new local models isn't wired up yet in this build.` with `The local model downloads automatically when scanned documents need it, or on demand above.`

Follow the file's existing class names (`btn ghost sm`, `pref-row`, `progress`) and its `describeStatus` helper (extend it rather than duplicating).

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit`. Then `npm start` → Settings → Local processing: rows render, `Download now` flips local-llm to a moving progress bar (real download! cancel it via the Cancel button unless you want the model), Cancel returns it to Standby with auto-install off.

```bash
git add src/renderer/screens/Settings/LocalProcessing.tsx
git commit -m "feat(settings): local model download controls + override picker"
```

---

### Task 17: Vendor script wiring, docs, end-to-end smoke

**Files:**
- Modify: `package.json` (scripts; electron-builder `extraResources`)
- Modify: `docs/rebuild/LEFTOVERS.md` (items 2, 3; gmail deviation)
- Verify: `scripts/fetch-llama-server.mjs`, `scripts/build-vision-helper.mjs`, `scripts/vendor-deep-extraction.mjs` (already in repo)

- [ ] **Step 1: npm script + packaging**

Read the headers of the three vendor scripts (they were carried over from the ref and may take env/args). Add to `package.json` scripts:

```json
    "vendor:inference": "node ./scripts/fetch-llama-server.mjs && node ./scripts/build-vision-helper.mjs",
```

adjusting invocation to what the scripts actually expect. Check the electron-builder `build` config in package.json: ensure `assets/llama/**` and `assets/vision/**` ship (they already do if the config includes the whole `assets` dir via `extraResources` — verify; add filters only if missing). Add `assets/llama/` and `assets/vision/` to `.gitignore` if the scripts download binaries there and they aren't ignored yet.

- [ ] **Step 2: Run the vendor step and smoke-test the helper**

Run: `npm run vendor:inference`
Expected: `assets/llama/<darwin-slug>/llama-server` and `assets/vision/darwin-arm64/kia-vision` exist and are executable (`ls -la` both).

- [ ] **Step 3: End-to-end smoke (manual, with the dev app)**

1. `npm start`.
2. Settings → Local processing: `apple-vision` shows **Ready**.
3. Add (or use an existing) local-folder account pointed at a folder; drop in a scanned PDF (an image-only PDF — print-to-PDF a photo if needed).
4. Wait for sync + the vision worker (window pref `always` speeds this up): the document's markdown gains `**Text content (OCR):**` and its text is findable via search.
5. Drop in a pure photo (no text): worker defers; within the 30 m re-drive (or trigger via Settings `Download now`) the Gemma download starts — progress bar in Settings; after it completes the photo gets a `**Description:**` and becomes searchable.
6. Gmail: send yourself an email with a PDF attachment; after the next delta sync, `search` (type `attachment`) finds it; once OCRed its content is searchable.
7. Verify Claude Desktop's MCP search can now find content that only exists inside a scanned attachment.

- [ ] **Step 4: Update LEFTOVERS.md**

- Item 2 (Inference providers): rewrite to state two providers now ship (`apple-vision` read, `local-llm` complete+see with tiered auto-download); phase C (Windows WinRT OCR, GLM-OCR fallback, Vulkan probing) remains deferred.
- Item 3 (Vision/OCR worker): mark implemented (two-pass via defer + enrich).
- Gmail deviation bullet: attachments ARE now emitted as child docs (metadata keys listed); historical threads backfill attachments only when the thread next changes.

- [ ] **Step 5: Full suite + commit**

Run: `npm test && npx tsc --noEmit`

```bash
git add package.json .gitignore docs/rebuild/LEFTOVERS.md
git commit -m "chore: vendor scripts wired, docs updated for local inference + OCR"
```
