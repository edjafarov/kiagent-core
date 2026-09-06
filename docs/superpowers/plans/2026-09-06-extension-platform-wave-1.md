# Extension platform wave 1 — lanes, model identity, emitter identity, outbox listing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An extension can run inference on the background lane with a deterministic decoding profile and learn which model will answer it before it calls; every delivered host event names its emitter; the outbox can be listed by status with an exact pending count.

**Architecture:** Three independent lanes. Lane A (#107) extends the inference plane and the local provider. Lane B (#112) threads host-stamped metadata from the event bus to the child process. Lane C (#113) extends the outbox store and its IPC. A and B share `host-surfaces.ts` and `contracts.ts`, so A merges before B opens; C touches neither and runs in parallel throughout.

**Tech Stack:** TypeScript, Electron 42, better-sqlite3, Jest, webpack (erb), release-it.

**Spec:** `docs/superpowers/specs/2026-09-06-extension-platform-track-design.md`

**Issues:** #107 (lane A), #112 (lane B), #113 (lane C). Each issue body is the requirements document for its lane — read it in full before the first task of that lane; the acceptance criteria in it are binding and are reproduced here only where a task needs them literally.

## Global Constraints

- Base: `dev` at `8bc2c670` (v0.85.0). Every line reference is against that commit.
- Every wire change is **additive**. `outbox:list` called with today's payload returns today's rows, in today's order, under today's default limit — with `to` and `cc` added to each row and no existing field changed. A one-argument `events.on` callback keeps compiling and running.
- One PR at a time may touch: `src/shared/contracts.ts`, `src/main/platform/host-surfaces.ts`, `src/main/platform/extension-host-entry.ts`, `src/shared/extension-rpc.ts`, `docs/architecture/extension-platform.md`. Lane A merges to `dev` before lane B opens a PR.
- No migration in this wave. Nothing touches `schema.ts`.
- `deterministic` profile: `maxTokens` required and **≤ 512**; a larger value rejects before the request reaches the model. This ceiling is deliberate (spec D1) — do not raise it.
- `generation` is never persisted; it starts at a random positive integer and the seed is injectable for tests (spec D3).
- Commit messages: conventional prefix, plain sentence, **no trailers** (no `Co-Authored-By`, no tool attribution) — repo convention.
- Gates before any PR: `npm run typecheck && npm run lint && npm test`.

---

## Lane A — #107

### Task 1: Lane pass-through, `host.inference.lane()`, `platform.lane` event

**Files:**
- Modify: `src/main/core/inference.ts` (`createInference`, `InferencePlane`)
- Modify: `src/main/platform/host-surfaces.ts:151-173` (inference surface), `:52-88` (`SurfaceDeps`)
- Modify: `src/main/platform/extension-platform.ts` (boot wiring of the platform's own emits) and its deps interface at `:155-170`
- Modify: `src/main/main.ts:975-998` (the `createExtensionPlatform({ … inference: p.inference … })` construction site)
- Modify: `src/shared/contracts.ts` (`Inference`, `CapSurfaces` inference namespace)
- Modify: `src/main/platform/extension-host-entry.ts:50-64` (`NS_METHODS.inference`)
- Test: `src/main/platform/__tests__/host-surfaces.test.ts`, `src/main/core/__tests__/inference.test.ts`

**Interfaces:**
- Consumes: `backgroundLaneState(platform, now?)` (`src/main/core/boot.ts:386-405`), `LaneState` (`contracts.ts:1136`).
- Produces: `InferencePlane.onLaneChange(cb: (state: LaneState) => void): () => void`; `SurfaceDeps.inference.lane(): Promise<LaneState>`; host event `platform.lane` with payload `{ state: LaneState }`.

**The plane cannot resolve `LaneState` on its own.** `backgroundLaneState` reads `platform.prefs` and `platform.scheduler.env` (`boot.ts:390-405`), and `extension-platform.ts` receives only `scheduler` and `inference: SurfaceDeps['inference']` (`:155-170`) — no `CorePlatform`. So the resolver is injected: `createExtensionPlatform` gains `laneState(): LaneState`, and `main.ts:975-998` passes `() => backgroundLaneState(p)` beside the existing `inference: p.inference`. Both `host.inference.lane()` and the `platform.lane` payload call that one resolver, which is what makes them unable to disagree.

- [ ] **Step 1: Write the failing surface test**

In `src/main/platform/__tests__/host-surfaces.test.ts`, replace the existing "inference forces the interactive lane" test (`:145`) with:

```ts
it('defaults to the interactive lane and passes background through', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const deps = makeDeps({
    inference: {
      complete: async (_p, opts) => { calls.push({ ...opts }); return 'ok'; },
      see: async () => '', read: async () => '', hear: async () => '',
      lane: async () => 'open' as const,
    },
  });
  const { surfaces } = buildSurfaces(deps);
  await surfaces.inference.complete('hi', { maxTokens: 8 });
  await surfaces.inference.complete('hi', { maxTokens: 8, lane: 'background' });
  expect(calls[0].lane).toBe('interactive');
  expect(calls[1].lane).toBe('background');
});

it('propagates LaneClosedError unchanged', async () => {
  const deps = makeDeps({
    inference: {
      complete: async () => { throw new LaneClosedError(); },
      see: async () => '', read: async () => '', hear: async () => '',
      lane: async () => 'until-idle' as const,
    },
  });
  const { surfaces } = buildSurfaces(deps);
  await expect(
    surfaces.inference.complete('hi', { maxTokens: 8, lane: 'background' }),
  ).rejects.toMatchObject({ name: 'LaneClosedError' });
});

it('reports the plane lane state', async () => {
  const { surfaces } = buildSurfaces(makeDeps({}));
  await expect(surfaces.inference.lane()).resolves.toBe('open');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx jest src/main/platform/__tests__/host-surfaces.test.ts -t 'lane'`
Expected: FAIL — the surface still overwrites `lane` and has no `lane()` member.

- [ ] **Step 3: Implement the surface change**

In `host-surfaces.ts`, the inference namespace stops overwriting the lane and gains `lane`:

```ts
inference: {
  complete: (prompt, opts) =>
    deps.inference.complete(String(prompt), { ...(opts as object) }),
  see: (image, prompt, opts) =>
    deps.inference.see(image as Uint8Array, String(prompt), { ...(opts as object) }),
  read: (image, opts) =>
    deps.inference.read(image as Uint8Array, { ...(opts as object) }),
  hear: (audio, opts) =>
    deps.inference.hear(audio as Uint8Array, { ...(opts as object) }),
  lane: () => deps.inference.lane(),
},
```

Add `lane(): Promise<LaneState>` to `SurfaceDeps.inference` and `'lane'` to `NS_METHODS.inference` (`extension-host-entry.ts:62`, today `['complete','see','read','hear']`). The extension platform passes `async () => deps.laneState()` when it builds the deps.

Tasks 2 and 4 add two more methods to the same three places — `describe` and `completeWithMeta`. A method that reaches `InferencePlane` but not `SurfaceDeps.inference`, `buildSurfaces` and `NS_METHODS.inference` is invisible to every extension: the child proxy is generated from `NS_METHODS` (`extension-host-entry.ts:109`), so nothing throws — the member simply does not exist. Add all three names as their tasks land, and let `cap-table-completeness.test.ts` be the check.

- [ ] **Step 4: Run the surface tests**

Run: `npx jest src/main/platform/__tests__/host-surfaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing lane-transition test**

In `src/main/core/__tests__/inference.test.ts`:

```ts
it('notifies lane subscribers only on a real transition', () => {
  const plane = createInference(fakeLogs());
  const seen: boolean[] = [];
  const off = plane.onLaneChange((open) => seen.push(open));
  plane.setBackgroundOpen(true);   // already true — no event
  plane.setBackgroundOpen(false);
  plane.setBackgroundOpen(false);  // no change — no event
  plane.setBackgroundOpen(true);
  off();
  plane.setBackgroundOpen(false);  // unsubscribed
  expect(seen).toEqual([false, true]);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx jest src/main/core/__tests__/inference.test.ts -t 'lane subscribers'`
Expected: FAIL — `onLaneChange` is not a function.

- [ ] **Step 7: Implement `onLaneChange`**

```ts
const laneSubs = new Set<(open: boolean) => void>();
// …
setBackgroundOpen(open) {
  if (open === backgroundOpen) return;
  backgroundOpen = open;
  laneSubs.forEach((cb) => cb(open));
},
onLaneChange(cb) {
  laneSubs.add(cb);
  return () => { laneSubs.delete(cb); };
},
```

Declare `onLaneChange` on `InferencePlane`.

**The boolean is not enough for the event.** `backgroundLaneState` distinguishes `disabled`, `battery`, `until-night`, `until-idle` and `open` (`boot.ts:390-405`); a move from `battery` to `disabled` leaves the boolean closed, so a listener that only hears boolean flips keeps a stale reason while `lane()` already reports the new one. The plane's callback stays boolean — it knows nothing about prefs — and the **extension platform** de-duplicates on the resolved `LaneState`: it calls the injected resolver on every notification and emits only when the resolved string changed. Since the platform also re-resolves on demand for `lane()`, the two cannot drift.

- [ ] **Step 8: Wire `platform.lane`**

In `extension-platform.ts`, next to the existing platform emits (`:424,:448`), subscribe once at boot:

```ts
let lastLane: LaneState | null = null;
const offLane = deps.inference.onLaneChange(() => {
  const state = deps.laneState();
  if (state === lastLane) return;
  lastLane = state;
  bus.emit('platform', 'platform.lane', { state });
});
```

Dispose `offLane` on platform shutdown alongside the other teardown handles. The payload carries the RESOLVED `LaneState`, not the boolean, so a listener learns *why* the lane is closed.

- [ ] **Step 9: Run the full platform + core suites**

Run: `npx jest src/main/core/__tests__/inference.test.ts src/main/platform`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/main/core/inference.ts src/main/platform src/shared/contracts.ts
git commit -m "feat(platform): extensions choose the inference lane and can read its state"
```

### Task 2: `describe()`, the generation token and `ModelChangedError`

**Files:**
- Modify: `src/main/core/inference.ts`
- Modify: `src/shared/contracts.ts` (`InferenceProvider` gains optional `describe`/`onChange`)
- Test: `src/main/core/__tests__/inference.test.ts`

**Interfaces:**
- Consumes: `pick(kind)` (`inference.ts:59-70`), `providers[]`, `register`.
- Produces:
  ```ts
  export class ModelChangedError extends Error {
    readonly expected: number; readonly actual: number; readonly modelId: string;
  }
  // InferencePlane
  describe(kind: 'complete'|'see'|'read'|'hear'):
    Promise<{ providerId: string; modelId: string; generation: number } | null>;
  complete(prompt, opts?: { maxTokens?; lane?; profile?; system?; generation?: number }): Promise<string>;
  completeWithMeta(prompt, opts?): Promise<{ text: string; providerId: string; modelId: string;
    generation: number; profile: 'default'|'deterministic'; promptTokens: number | null;
    completionTokens: number | null; truncated: boolean }>;
  // InferenceProvider (both new members optional)
  describe?(kind): { modelId: string } | null;
  onChange?(cb: () => void): () => void;
  ```

- [ ] **Step 1: Write the failing generation tests**

```ts
it('bumps the generation on register, unregister and provider change', () => {
  const plane = createInference(fakeLogs(), { generationSeed: 100 });
  let fire: () => void = () => {};
  const p = fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1',
    onChange: (cb) => { fire = cb; return () => {}; } });
  const off = plane.register(p);
  const g1 = plane.generation();
  fire();
  expect(plane.generation()).toBe(g1 + 1);
  off();
  expect(plane.generation()).toBe(g1 + 2);
});

it('rejects a stale generation before the provider is called', async () => {
  const plane = createInference(fakeLogs(), { generationSeed: 100 });
  const handle = jest.fn(async () => 'never');
  plane.register(fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1', handle }));
  const d = await plane.describe('complete');
  plane.register(fakeProvider({ id: 'y', supports: ['see'], modelId: 'm2' })); // bumps
  await expect(
    plane.complete('hi', { maxTokens: 8, generation: d!.generation }),
  ).rejects.toMatchObject({ name: 'ModelChangedError', expected: d!.generation });
  expect(handle).toHaveBeenCalledTimes(0);
});

it('returns the same identity to concurrent describers', async () => {
  const plane = createInference(fakeLogs(), { generationSeed: 7 });
  plane.register(fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1' }));
  const [a, b] = await Promise.all([plane.describe('complete'), plane.describe('complete')]);
  expect(a).toEqual(b);
});

it('describes null when no provider is ready', async () => {
  const plane = createInference(fakeLogs());
  await expect(plane.describe('complete')).resolves.toBeNull();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/core/__tests__/inference.test.ts -t 'generation'`
Expected: FAIL — `describe`/`generation` are not functions.

- [ ] **Step 3: Implement identity and the generation counter**

```ts
export class ModelChangedError extends Error {
  readonly expected: number; readonly actual: number; readonly modelId: string;
  constructor(expected: number, actual: number, modelId: string) {
    super(`the model changed between lookup and call (expected generation ${expected}, now ${actual})`);
    this.name = 'ModelChangedError';
    this.expected = expected; this.actual = actual; this.modelId = modelId;
  }
}

export function createInference(
  logs: LogSink,
  opts?: { generationSeed?: number },
): InferencePlane {
  // Random start: a restart is a new generation by construction, and nothing
  // persists it. Tests pass a seed.
  let generation = opts?.generationSeed ?? 1 + Math.floor(Math.random() * 1_000_000);
  const bump = () => { generation += 1; };
  // …
}
```

`register` bumps, the returned unregister bumps, and `register` subscribes to `provider.onChange?.(bump)`, disposing that subscription in the unregister closure. `describe(kind)` resolves the provider with the same `pick(kind)` the call path uses, returns `null` on `NoProviderError`, and otherwise `{ providerId: p.id, modelId: p.describe?.(kind)?.modelId ?? p.id, generation }`. Every `complete/see/read/hear` compares `opts.generation` — when present — against `generation` AFTER `pick()` and throws `ModelChangedError` before `p.handle(…)`.

**The plane must widen the payload it builds.** Today it constructs `payload: { prompt, maxTokens: opts?.maxTokens }` (`inference.ts:76-80`) and nothing else — so `profile`, `system`, `generation` and `expectModelId` all reach the provider only if this object carries them. Teaching the provider to read `req.payload.profile` without widening this construction leaves every host call on the default profile with no system message, silently.

**The plane's check is not sufficient on its own, and task 3 is the other half.** The plane compares a *counter* after it resolved a *provider*; the local provider resolves the *model* later still, inside `handle()` (`provider.ts:296`). So when the caller passed a `generation`, the plane also resolves the model id it believes is current — `p.describe?.(kind)?.modelId` — and threads it into the request as `payload.expectModelId`, alongside `payload.generation`. A provider that ignores the field behaves exactly as it does today; the local provider re-checks it against the model it actually resolved and throws before any HTTP request. Without this the window between `pick()` and `servableModel()` stays open, and #107's acceptance criterion — a mock `fetch` asserting zero calls — cannot pass.

- [ ] **Step 4: Run the tests**

Run: `npx jest src/main/core/__tests__/inference.test.ts`
Expected: PASS, and the stale-generation test asserts `handle` was never called.

- [ ] **Step 5: Add `completeWithMeta`**

```ts
it('returns identity and usage with the completion', async () => {
  const plane = createInference(fakeLogs(), { generationSeed: 5 });
  plane.register(fakeProvider({ id: 'x', supports: ['complete'], modelId: 'm1',
    handle: async () => ({ text: 'hi', promptTokens: 9, completionTokens: 2, truncated: true }) }));
  await expect(plane.completeWithMeta('p', { maxTokens: 8 })).resolves.toEqual({
    text: 'hi', providerId: 'x', modelId: 'm1', generation: 5,
    profile: 'default', promptTokens: 9, completionTokens: 2, truncated: true,
  });
});
```

A provider may return a plain string (every provider does today) or the richer record; `completeWithMeta` normalises a string to `{ text, promptTokens: null, completionTokens: null, truncated: false }`, and `complete()` stays `Promise<string>` by returning `.text`.

- [ ] **Step 6: Run, then commit**

Run: `npx jest src/main/core/__tests__/inference.test.ts`

```bash
git add src/main/core/inference.ts src/shared/contracts.ts
git commit -m "feat(inference): expose model identity before a call and reject a changed generation"
```

### Task 3: Local provider — `describe`, `onChange`, and the identity check inside `handle()`

**Files:**
- Modify: `src/main/providers/local-llm/provider.ts:296-318` (`handle`), model-selection sites
- Test: `src/main/providers/local-llm/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: `servableModel()`, `selectedModel` (provider-internal), `ModelChangedError` from Task 2.
- Produces: `describe(kind)` returning `{ modelId: servableModel()?.id }` or `null`; `onChange(cb)` firing once per model switch.

- [ ] **Step 1: Write the failing tests**

```ts
it('describes the servable model', () => {
  const p = makeProvider({ servable: { id: 'gemma-3n-e4b' } });
  expect(p.describe!('complete')).toEqual({ modelId: 'gemma-3n-e4b' });
});

it('rejects and issues no request when the model changed after describe', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch');
  const p = makeProvider({ servable: { id: 'a' } });
  const before = p.describe!('complete');
  setServable(p, { id: 'b' });
  await expect(
    p.handle({ kind: 'complete', lane: 'interactive',
      payload: { prompt: 'x', maxTokens: 8, generation: 1, expectModelId: before!.modelId } }),
  ).rejects.toMatchObject({ name: 'ModelChangedError' });
  expect(fetchSpy).toHaveBeenCalledTimes(0);
});

it('fires onChange once per model switch', () => { /* … */ });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/providers/local-llm/__tests__/provider.test.ts -t 'describe'`
Expected: FAIL — `describe` is undefined.

- [ ] **Step 3: Implement**

`handle()` already resolves the model first (`provider.ts:296`, `const model = servableModel()`). Immediately after that line, before `ensureServer`, compare the payload's `expectModelId` (threaded by the plane from the caller's `generation` lookup) with `model.id` and throw `ModelChangedError` when they differ. This is the check that matters: the plane's own comparison happens before `pick()` resolves a *provider*, while the local provider only resolves a *model* here.

- [ ] **Step 4: Run, then commit**

Run: `npx jest src/main/providers/local-llm`

```bash
git add src/main/providers/local-llm
git commit -m "feat(local-llm): report the servable model and refuse a call whose model moved"
```

### Task 4: The deterministic profile, `system`, and usage mapping

**Files:**
- Modify: `src/main/providers/local-llm/api.ts:24-58` (`chatText`)
- Modify: `src/main/providers/local-llm/provider.ts` (thread `profile`, `system`, `generation` from `req.payload`)
- Create: `src/main/providers/local-llm/__tests__/api-profile.test.ts`

**Interfaces:**
- Consumes: `VLM_TEMPERATURE`, `CHAT_TEMPLATE_KWARGS`, `VLM_MAX_TOKENS` (`api.ts:11,15,22`).
- Produces: `chatText(baseUrl, prompt, opts: { maxTokens?; profile?: 'default'|'deterministic'; system?: string })` returning `{ text, promptTokens, completionTokens, truncated }`.

- [ ] **Step 1: Write the failing profile test**

```ts
it('sends the exact deterministic body', async () => {
  const fetchMock = mockFetch({ choices: [{ message: { content: 'A' }, finish_reason: 'stop' }] });
  await chatText('http://x', 'p', { maxTokens: 64, profile: 'deterministic', system: 'S' });
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({
    temperature: 0, top_k: 1, top_p: 1, seed: 0, n: 1, max_tokens: 64,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'S' }] },
      { role: 'user', content: [{ type: 'text', text: 'p' }] },
    ],
  });
});

it('refuses a deterministic request over the ceiling before calling out', async () => {
  const fetchMock = mockFetch({});
  await expect(chatText('http://x', 'p', { maxTokens: 513, profile: 'deterministic' }))
    .rejects.toThrow(/maxTokens/);
  expect(fetchMock).toHaveBeenCalledTimes(0);
});

it('leaves the default profile unchanged', async () => { /* temperature 0.1, no seed/top_k/top_p */ });

it('maps usage and a length finish to truncated', async () => {
  const fetchMock = mockFetch({
    choices: [{ message: { content: 'A' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  });
  await expect(chatText('http://x', 'p', { maxTokens: 8 })).resolves.toEqual({
    text: 'A', promptTokens: 11, completionTokens: 3, truncated: true,
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/providers/local-llm/__tests__/api-profile.test.ts`
Expected: FAIL — the module has no `profile` handling and returns a bare string.

- [ ] **Step 3: Implement in `api.ts`**

The profile is resolved inside `chatText`, never by a caller assembling a body:

```ts
export const DETERMINISTIC_MAX_TOKENS = 512;

const profileBody = (profile: 'default' | 'deterministic', maxTokens?: number) => {
  if (profile === 'default') {
    return { temperature: VLM_TEMPERATURE, max_tokens: maxTokens ?? VLM_MAX_TOKENS };
  }
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new Error("the 'deterministic' profile requires an integer maxTokens");
  }
  if (maxTokens > DETERMINISTIC_MAX_TOKENS) {
    throw new Error(
      `the 'deterministic' profile caps maxTokens at ${DETERMINISTIC_MAX_TOKENS} (got ${maxTokens})`,
    );
  }
  return { temperature: 0, top_k: 1, top_p: 1, seed: 0, n: 1, max_tokens: maxTokens };
};
```

`chatText` returns the record, and the production caller — `provider.ts:308`, `return chatText(s.baseUrl(), prompt, { maxTokens })` — returns the **whole record** to the plane, not `.text`. Taking `.text` there would make task 2's string-normalisation path replace real usage numbers with `null` and a real truncation with `false`, which is exactly what `completeWithMeta` exists to report. The only other call site is `src/main/providers/local-llm/__tests__/api.test.ts:79`, which awaits without consuming the return value. `see`/`read`/`hear` accept `profile` in their options, ignore it, and log the fact once per process — they never throw on it.

- [ ] **Step 4: Run the provider suite**

Run: `npx jest src/main/providers/local-llm`
Expected: PASS, including the pre-existing callers that now read `.text`.

- [ ] **Step 5: Record the local repeatability check**

Add to `docs/architecture/extension-platform.md`, in the inference row: 20 runs of one prompt against one model under `deterministic` produce identical text on one machine; bitwise determinism across hardware is NOT promised, and repeatability for a consumer comes from its own persisted result, not from the sampler. Note that this check is run by hand on a developer machine, not in CI.

- [ ] **Step 6: Commit**

```bash
git add src/main/providers/local-llm docs/architecture/extension-platform.md
git commit -m "feat(local-llm): deterministic decoding profile, system message and usage metadata"
```

### Task 5: `host.query.countBy`

**Files:**
- Modify: `src/main/platform/host-surfaces.ts:112-125`, `src/main/platform/extension-host-entry.ts:50-64`
- Modify: `src/shared/contracts.ts` (`CapSurfaces.query`)
- Test: `src/main/platform/__tests__/host-surfaces.test.ts`, `src/main/platform/__tests__/cap-table-completeness.test.ts`

**Interfaces:**
- Consumes: `Query.countBy` (`contracts.ts:245-253`, implemented `store.ts:778`).
- Produces: `host.query.countBy(q)` — same signature and 100-group cap as the store method.

- [ ] **Step 1: Write the failing delegation test**

```ts
it('delegates countBy to the query plane', async () => {
  const countBy = jest.fn(async () => [{ key: 'a@example.com', count: 3 }]);
  const { surfaces } = buildSurfaces(makeDeps({ query: { ...stubQuery, countBy } }));
  await expect(surfaces.query.countBy({ field: 'from' }))
    .resolves.toEqual([{ key: 'a@example.com', count: 3 }]);
  expect(countBy).toHaveBeenCalledWith({ field: 'from' });
});
```

`countBy` groups by `field: 'from' | 'label'` only (`contracts.ts:245-253`); `type`, `account` and the date bounds are filters, not grouping keys. A permissive mock will happily accept `{ by: 'type' }` and prove nothing.

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/platform/__tests__/host-surfaces.test.ts -t countBy`
Expected: FAIL — `surfaces.query.countBy is not a function`.

- [ ] **Step 3: Implement**

Add `countBy: (q) => deps.query.countBy((q ?? {}) as never)` to the query surface and `'countBy'` to `NS_METHODS.query`. No new cap: `query` already covers it.

- [ ] **Step 4: Run the drift guard**

Run: `npx jest src/main/platform/__tests__/cap-table-completeness.test.ts src/main/platform/__tests__/host-surfaces.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/platform src/shared/contracts.ts
git commit -m "feat(platform): expose query.countBy to extensions"
```

### Task 6: End-to-end across the RPC boundary, and the docs row

**Files:**
- Modify: `src/main/platform/__tests__/extension-e2e.test.ts`
- Modify: `docs/architecture/extension-platform.md` (inference row)

- [ ] **Step 1: Write the failing e2e cases**

Two cases, both through a forked fixture extension, because both errors have to survive serialization by NAME:

```ts
it('delivers LaneClosedError to a forked extension', async () => {
  plane.setBackgroundOpen(false);
  await expect(fixture.call('completeBackground')).rejects.toMatchObject({
    name: 'LaneClosedError',
  });
});

it('delivers ModelChangedError to a forked extension', async () => {
  const first = await fixture.call('describeThenComplete'); // describes, then we bump
  expect(first).toMatchObject({ name: 'ModelChangedError' });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/platform/__tests__/extension-e2e.test.ts -t Error`
Expected: FAIL.

- [ ] **Step 3: Preserve the error name across RPC**

The name is discarded in **`transport.ts`**, not in `extension-host-entry.ts`. The reply side serializes `e instanceof Error ? e.message : String(e)` plus `sourceErrorCode(e)` (`transport.ts:254-258`), and the receiving side rebuilds `new Error(r.error ?? 'remote error')` and attaches only `code` (`:268-274`). So both ends of `transport.ts` change, together with the `ReplyMsg` wire type in `src/shared/extension-rpc.ts`: carry `name` and a small allow-listed set of own enumerable fields (`expected`, `actual`, `modelId`), and reattach them on reconstruction. `LaneClosedError` crosses today as a message-only error — this is the fix that makes the acceptance criterion true for both errors.

- [ ] **Step 4: Run the full platform suite**

Run: `npx jest src/main/platform`
Expected: PASS.

- [ ] **Step 5: Update the docs row and commit**

`docs/architecture/extension-platform.md`, inference row: list `lane`, `describe`, `completeWithMeta`, `profile`, `system`, `generation`, and name `LaneClosedError` and `ModelChangedError` as the two errors a caller must handle. State the caching rationale in one sentence: a persisted result cache is keyed on the canonical effective request plus the `modelId` from `describe()`, and the generation token turns a model switch between lookup and call into a rejected call rather than a wrong cache entry.

```bash
git add src/main/platform docs/architecture/extension-platform.md src/shared/extension-rpc.ts
git commit -m "test(platform): pin lane and model-identity errors across the extension boundary"
```

- [ ] **Step 6: Open the lane A PR**

Full gates first: `npm run typecheck && npm run lint && npm test`. PR title: "Extensions: background lane, deterministic profile, model identity and countBy". Body closes #107. **Lane B does not open a PR until this one merges.**

---

## Lane B — #112 (opens after lane A merges)

### Task 7: Host-stamped emitter identity on every delivered event

**Files:**
- Modify: `src/main/platform/host-surfaces.ts:19-46` (`EventBus`), `:87-88` (`SurfaceDeps.deliverEvent`), `:174-203` (events surface)
- Modify: `src/main/platform/host-process.ts:170-171`, `src/shared/extension-rpc.ts:96`, `src/main/platform/extension-host-entry.ts:426-427`
- Modify: `src/shared/contracts.ts:918-923` (`CapSurfaces.events.on`), export `EventMeta`
- Test: `src/main/platform/__tests__/host-surfaces.test.ts`, `.../extension-host-entry.test.ts`, `.../extension-e2e.test.ts`, `.../transport.test.ts`

**Interfaces:**
- Produces: `export interface EventMeta { from: string; at: number }`, exported from `src/shared/contracts.ts` next to `CapSurfaces`.

- [ ] **Step 1: Write the failing bus tests**

```ts
it('stamps the emitter on delivery', () => {
  const bus = createEventBus();
  const seen: Array<[unknown, EventMeta]> = [];
  bus.subscribe('b', 'x.record', (p, meta) => seen.push([p, meta]));
  bus.emit('a', 'x.record', { producer: 'b' });
  expect(seen[0][1].from).toBe('a');       // NOT the payload's claim
  expect(typeof seen[0][1].at).toBe('number');
});

it('stamps the surface owner, not an argument', () => {
  const { surfaces } = buildSurfaces(makeDeps({ extensionId: 'kiagent.a' }));
  // …emit through the surface, assert meta.from === 'kiagent.a'
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/platform/__tests__/host-surfaces.test.ts -t stamps`
Expected: FAIL — the callback receives one argument.

- [ ] **Step 3: Thread `meta` through the bus and the surface**

```ts
export interface EventMeta { from: string; at: number }

export interface EventBus {
  emit(from: string, event: string, payload: unknown): void;
  subscribe(
    extensionId: string,
    event: string,
    deliver: (payload: unknown, meta: EventMeta) => void,
  ): () => void;
}

emit(from, event, payload) {
  const meta: EventMeta = { from, at: Date.now() };
  subs.get(event)?.forEach((cb) => cb(payload, meta));
},
```

The surface's subscribe callback becomes `(p, meta) => deps.deliverEvent(name, p, meta)`. `from` is `deps.extensionId` or the literal `'platform'` and is never read from the payload or from any argument an extension controls; the reserved-prefix guard at `:196-200` stays, which is what makes `'platform'` unforgeable.

- [ ] **Step 4: Carry `meta` to the child**

`{ kind: 'event', name, payload, meta }` in `extension-rpc.ts:96`; `host-process.ts:170-171` posts it; `extension-host-entry.ts:426-427` dispatches `cb(msg.payload, msg.meta)`. `EventMeta` is plain data and survives `serialization: 'advanced'` unchanged — pin that in `transport.test.ts`.

- [ ] **Step 5: Prove a one-argument listener still works**

```ts
it('keeps one-argument listeners working', () => {
  const seen: unknown[] = [];
  host.events.on('x.record', (p) => seen.push(p));   // no meta parameter
  deliver({ kind: 'event', name: 'x.record', payload: { a: 1 }, meta: { from: 'z', at: 1 } });
  expect(seen).toEqual([{ a: 1 }]);
});
```

- [ ] **Step 6: Write the two-extension e2e case**

A and B both forked. A emits `x.record` with a payload claiming `producer: 'kiagent.b'`; B's listener sees `meta.from === 'kiagent.a'`. Platform `extension.activated` reaches B with `meta.from === 'platform'`. Repeat both assertions on the bundled in-memory transport path (`extension-platform.ts:520-527`) — the two tiers must agree.

- [ ] **Step 7: Run everything, then commit**

Run: `npx jest src/main/platform`

```bash
git add src/main/platform src/shared
git commit -m "feat(platform): every delivered event names the extension that emitted it"
```

- [ ] **Step 8: Docs and PR**

`docs/architecture/extension-platform.md:83` (the `events` row): a listener receives `(payload, meta)`; `meta.from` is host-stamped and cannot be forged by a payload field; there is no filtering, ACL, persistence or replay — a listener now has the information to accept or reject what it receives. Gates, then a PR closing #112.

---

## Lane C — #113 (parallel from the start; touches none of lane A/B's files)

### Task 8: Outbox store — `list`, `countPending`, `onChange`

**Files:**
- Modify: `src/main/core/store/outbox.ts` (`OutboxStore` interface and factory)
- Test: `src/main/core/store/__tests__/outbox.test.ts`

**Interfaces:**
- Consumes: `db.all`, `db.batch` (`AppDb`), `toRow`, `OUTBOX_PENDING_CAP` (`outbox.ts:20`).
- Produces:
  ```ts
  list(opts: { limit: number; status?: OutboxStatus[];
               before?: { createdAt: string; id: string } }): Promise<OutboxRow[]>;
  countPending(): Promise<number>;
  onChange(cb: () => void): () => void;
  ```
  `listRecent` stays — the MCP `list_outbox` path (`outbound/service.ts:124`) keeps using it.

- [ ] **Step 1: Write the failing store tests**

```ts
it('finds a pending draft behind 50 newer sent rows', async () => {
  await seedSent(50);
  const draft = await seedDraft({ createdAt: '2026-01-01T00:00:00.000Z' });
  const rows = await store.outbox.list({ status: ['draft'], limit: 100 });
  expect(rows.map((r) => r.id)).toContain(draft.id);
});

it('pages 120 drafts by keyset with no gap and no duplicate', async () => {
  // 6 accounts × 20 — OUTBOX_PENDING_CAP is 20 per account
  const seeded = await seedDrafts(120);
  const first = await store.outbox.list({ status: ['draft'], limit: 100 });
  const last = first[first.length - 1];
  const second = await store.outbox.list({
    status: ['draft'], limit: 100,
    before: { createdAt: last.createdAt, id: last.id },
  });
  expect(first).toHaveLength(100);
  expect(second).toHaveLength(20);
  const ids = [...first, ...second].map((r) => r.id);
  expect(new Set(ids).size).toBe(120);
  expect(new Set(ids)).toEqual(new Set(seeded.map((r) => r.id)));
});

it('counts pending across accounts and follows a transition', async () => {
  await seedDrafts(120);
  expect(await store.outbox.countPending()).toBe(120);
  const [one] = await store.outbox.list({ status: ['draft'], limit: 1 });
  await store.outbox.transition(one.id, ['draft'], 'sent');
  expect(await store.outbox.countPending()).toBe(119);
});

it('fires onChange once per effective change and never on a no-op', async () => {
  const cb = jest.fn();
  store.outbox.onChange(cb);
  const row = await seedDraft({});
  expect(cb).toHaveBeenCalledTimes(1);                                  // create
  await store.outbox.transition(row.id, ['draft'], 'sent');
  expect(cb).toHaveBeenCalledTimes(2);                                  // moved
  await store.outbox.transition(row.id, ['draft'], 'sent');             // no-op
  expect(cb).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -t 'keyset'`
Expected: FAIL — `store.outbox.list is not a function`.

- [ ] **Step 3: Implement**

```ts
async list({ limit, status, before }) {
  const where: string[] = [];
  const params: AppDbParam[] = [];   // AppDb.all requires AppDbParam[], not unknown[]
  if (status?.length) {
    where.push(`status IN (${status.map(() => '?').join(',')})`);
    params.push(...status);
  }
  if (before) {
    // Matches ORDER BY created_at DESC, id DESC exactly.
    where.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
    params.push(before.createdAt, before.createdAt, before.id);
  }
  const rows = (await db.all(
    `SELECT * FROM outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit],
  )) as unknown as OutboxRowSql[];
  return rows.map(toRow);
},
```

`countPending` is `SELECT COUNT(*) FROM outbox WHERE status = 'draft'`. `onChange` keeps a `Set` of callbacks fired from `create`, from `transition` **only when the compare-and-set reported one changed row**, and from `expireOverdue` **only when rows changed**.

**One more writer exists and it is not in this file.** `outbox.account_id` is `REFERENCES accounts(id) ON DELETE CASCADE` (`schema.ts:561`), and `write-tx.ts:510` runs `DELETE FROM accounts WHERE id = ?` — so removing an account erases its outbox rows without any of the three hooks firing, and both the listing and the count go stale with nothing to announce it. Fire `onChange` from the account-removal path too, and pin it:

```ts
it('announces the rows a removed account took with it', async () => {
  const cb = jest.fn();
  store.outbox.onChange(cb);
  await seedDraft({ accountId });
  cb.mockClear();
  await store.removeAccount(accountId);
  expect(cb).toHaveBeenCalled();
  expect(await store.outbox.countPending()).toBe(0);
});
```

- [ ] **Step 4: Run and commit**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts`

```bash
git add src/main/core/store/outbox.ts src/main/core/store/__tests__/outbox.test.ts
git commit -m "feat(outbox): status-filtered keyset listing, a pending count and a change signal"
```

### Task 9: `outbox:list` filter and cursor, `outbox:pending-count`, addresses on rows

**Files:**
- Modify: `src/main/outbound/ipc.ts:110-149`
- Modify: `src/shared/ipc.ts:358` (`outbox:list` req), `:196-224` (`OutboxPanelRow`), `:227` (`Invokes`), `:558` (the `0`-keyed map behind `INVOKE_CHANNELS`)
- Test: `src/main/outbound/__tests__/ipc.test.ts`, `src/main/__tests__/ipc-handler-coverage.test.ts`

**Interfaces:**
- Consumes: Task 8's `list`/`countPending`.
- Produces: `outbox:list { limit?, status?: OutboxStatus[], before?: { createdAt: string; draftId: string } }`; `outbox:pending-count { req: void; res: { pending: number } }`; `OutboxPanelRow` gains `to: string[]` and `cc: string[]`.

- [ ] **Step 1: Write the regression pin FIRST**

Before adding anything, pin today's behaviour, because this is the one call a shipped renderer already makes:

```ts
it('keeps every field and the listing semantics it has today', async () => {
  const rows = await handlers['outbox:list'](undefined);
  expect(rows).toHaveLength(50);                       // default limit unchanged
  expect(rows).toEqual(await handlers['outbox:list']({ limit: 50 }));
  // Pin the SHAPE against a literal, not against another call to the same code.
  expect(Object.keys(rows[0]).sort()).toEqual([
    'accountLabel', 'bodyPreview', 'canRetry', 'cc', 'createdAt', 'deliveryUncertain',
    'draftId', 'error', 'errorDetail', 'kind', 'recipientDisplay', 'sentAt',
    'status', 'subject', 'to',
  ]);
  expect(rows.map((r) => r.draftId)).toEqual(newestFirst(seeded).slice(0, 50).map((r) => r.id));
});
```

Compatibility here means **every existing field and the existing ordering and default survive, and `to`/`cc` are added** — not a byte-identical response. Comparing two calls to the same implementation pins nothing; the literal key list is the pin.

- [ ] **Step 2: Write the failing new cases**

```ts
it('filters by status', async () => {
  const rows = await handlers['outbox:list']({ status: ['draft'] });
  expect(rows.every((r) => r.status === 'draft')).toBe(true);
});

it('pages with the before cursor', async () => {
  const first = await handlers['outbox:list']({ status: ['draft'], limit: 100 });
  const tail = first[first.length - 1];
  const second = await handlers['outbox:list']({
    status: ['draft'], limit: 100,
    before: { createdAt: tail.createdAt, draftId: tail.draftId },
  });
  expect(second.map((r) => r.draftId)).not.toContain(tail.draftId);
});

it('counts pending after the sweep expired an overdue draft', async () => {
  await seedDraft({ expiresAt: '2020-01-01T00:00:00.000Z' });
  await expect(handlers['outbox:pending-count'](undefined))
    .resolves.toEqual({ pending: await store.outbox.countPending() });
});

it('carries recipient addresses verbatim', async () => {
  const [row] = await handlers['outbox:list']({ status: ['draft'], limit: 1 });
  expect(row.to).toEqual(['a@example.com']);
  expect(row.cc).toEqual([]);
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `npx jest src/main/outbound/__tests__/ipc.test.ts`
Expected: the regression pin PASSES, the four new cases FAIL.

- [ ] **Step 4: Implement**

`outbox:list` keeps the sweep and the `[1,100]` clamp exactly where they are, then calls `store.outbox.list({ limit: clamped, status: req?.status, before: req?.before && { createdAt: req.before.createdAt, id: req.before.draftId } })`. The row mapper adds `to: row.to` and `cc: row.cc`. `outbox:pending-count` sweeps first, then returns `{ pending: await store.outbox.countPending() }`.

Register the new invoke in **both** places — `Invokes` and the `0`-keyed map that `INVOKE_CHANNELS` derives from (`ipc.ts:558`). The preload allow-list is derived from that map (`src/main/preload.ts:7-8`), so a channel missing there is rejected before it ever reaches `ipcMain`, and no unit test would catch it.

- [ ] **Step 5: Run, including the coverage guard**

Run: `npx jest src/main/outbound src/main/__tests__/ipc-handler-coverage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/outbound src/shared/ipc.ts src/main/__tests__
git commit -m "feat(outbox): filter and page the listing, expose a pending count and recipient addresses"
```

### Task 10: `push:outbox-changed`, coalesced

**Files:**
- Modify: `src/main/main.ts` (near the `push:mcp-activity` broadcast at `:841`; `broadcast` is defined at `:192`)
- Modify: `src/shared/ipc.ts` (`Pushes` at `:488` and the `0`-keyed map behind `PUSH_CHANNELS` at `:603`)
- Test: a main-level test beside the existing push tests

**Interfaces:**
- Consumes: Task 8's `onChange`.
- Produces: push channel `push:outbox-changed`, payload `void`, at most one per 50 ms.

- [ ] **Step 1: Write the failing coalescing test**

```ts
it('broadcasts once for a burst and again for a later change', async () => {
  jest.useFakeTimers();
  wireOutboxPush(store, broadcast);
  fireChange(); fireChange(); fireChange();
  jest.advanceTimersByTime(50);
  expect(broadcast).toHaveBeenCalledTimes(1);
  fireChange();
  jest.advanceTimersByTime(50);
  expect(broadcast).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest -t 'broadcasts once for a burst'`
Expected: FAIL — no such wiring.

- [ ] **Step 3: Implement**

```ts
let pending: NodeJS.Timeout | null = null;
store.outbox.onChange(() => {
  if (pending) return;
  pending = setTimeout(() => { pending = null; broadcast('push:outbox-changed'); }, 50);
});
```

Register the channel in `Pushes` and in the `0`-keyed map behind `PUSH_CHANNELS`.

- [ ] **Step 4: Run and commit**

Run: `npm test`

```bash
git add src/main/main.ts src/shared/ipc.ts src/main/__tests__
git commit -m "feat(outbox): announce outbox changes to the renderer"
```

- [ ] **Step 5: Open the lane C PR**

Gates, then a PR closing #113. It may open and merge at any point in the wave — it shares no file with lanes A and B.

---

## Task 11: Release v0.86.0

- [ ] **Step 1: Confirm all three lanes are on `dev`**

```bash
git log --oneline origin/dev | head -20
gh issue view 107 --json state; gh issue view 112 --json state; gh issue view 113 --json state
```
Expected: three CLOSED issues.

- [ ] **Step 2: Run the full gate on `dev`**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

- [ ] **Step 3: Release**

`npm run release` (release-it; the changelog is generated from commit subjects — this is why each subject above reads as an outcome, not as a task number).

- [ ] **Step 4: Record what became available**

In the release notes: the background lane and its `LaneClosedError`, `lane()` and the `platform.lane` event, the `deterministic` profile with its 512-token ceiling, `describe()` / `completeWithMeta` / `ModelChangedError`, `query.countBy`, `EventMeta` on every delivered event, and the outbox listing, count, addresses and push. Downstream consumers pin this tag when they adopt them.

---

## Self-review notes

- **Spec coverage.** #107 → tasks 1–6 (lane, identity, provider, profile, countBy, e2e/docs). #112 → task 7. #113 → tasks 8–10. Release → task 11.
- **The one interface two lanes share** is `SurfaceDeps` in `host-surfaces.ts`: task 1 adds `inference.lane`, task 7 adds a parameter to `deliverEvent`. That is why lane A merges before lane B opens, and it is the only reason.
- **Not in this wave, on purpose:** grammar-constrained output (#109), a per-extension token budget, event persistence or replay, any renderer rendering of the outbox count, and any change to the vision worker's requests.
