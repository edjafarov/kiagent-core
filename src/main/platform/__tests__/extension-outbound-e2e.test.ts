/**
 * @jest-environment node
 *
 * The two extension-hop contracts that only a REAL forked child can prove,
 * because both are about a value surviving process serialization:
 *
 *  1. The universality hook (spec §6), producer end to consumer end. A
 *     source writes `metadata.outbound` in its own toDocument — which runs in
 *     the CHILD — and the opaque `ref` inside it has to come back to that
 *     same extension's Sender byte for byte, both for the document default
 *     and for a per-message `targets[]` entry the model selects by key.
 *     service.test.ts pins the service's half against an in-process fake
 *     sender; nothing pinned the full loop through the wire.
 *
 *  2. The source-error taxonomy across the boundary: a plain Error carrying
 *     `code: 'auth'` (an extension cannot construct a SourceAuthError this
 *     bundle would recognize) must still land the account on 'needsReauth'.
 *     needs-reauth.test.ts covers the rehydrated SHAPE against a bundled
 *     source; this covers the hop that produces it.
 *
 * Deliberately separate from extension-e2e.test.ts rather than appended to
 * it: that suite is a known flake under full-suite CPU contention (it is
 * excluded from the CI fast gate for exactly that reason), and these fork
 * their own children. Run isolated.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AuthChannel,
  McpTool,
  Prefs,
  Sender,
  Source,
} from '@shared/contracts';

import { createEngine } from '@main/core/engine/engine';
import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';
import { createOutboundService } from '@main/outbound/service';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from '../extension-platform';
import { nodeForkTransport } from '../transport';

jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const SENDER_FIXTURE = path.join(__dirname, 'fixtures', 'ext-sender');
const AUTHFAIL_FIXTURE = path.join(__dirname, 'fixtures', 'ext-auth-fail');

const noInference = {
  complete: async () => '',
  see: async () => '',
  read: async () => '',
  hear: async () => '',
};

const fakePrefs = (): Prefs => ({
  get: () => ({}) as never,
  patch: async () => {},
  onChange: () => () => {},
});

async function waitUntil(
  cond: () => Promise<boolean> | boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => {
      setTimeout(r, 200);
    });
  }
}

describe('extension outbound + error taxonomy e2e (real forked child)', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const registry = new Map<string, Source>();
  const senderRegistry = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();
  // Both contracts here are ABOUT the process boundary, so each test checks
  // that this factory ran: the in-process tier (`unsafe.mainProcess`, which
  // neither fixture declares) never calls it, and would otherwise satisfy
  // every assertion below without a child existing at all.
  let forks = 0;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-outbound-e2e-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s) => void registry.set(s.descriptor.id, s),
        get: (id) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id) => void registry.delete(id),
      },
      senders: {
        register: (id, s) => void senderRegistry.set(id, s),
        get: (id) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: (t) => {
        tools.set(t.name, t);
        return () => tools.delete(t.name);
      },
      inference: noInference,
      laneState: () => 'open',
      onLaneChange: () => () => {},
      logSink: {
        log: (...a) => process.stderr.write(`${JSON.stringify(a)}\n`),
      },
      notify: () => {},
      transportFactory: () => {
        forks += 1;
        return nodeForkTransport(CHILD_ENTRY, {
          cwd: REPO_ROOT,
          execArgv: [
            '-r',
            'ts-node/register/transpile-only',
            '-r',
            'tsconfig-paths/register',
          ],
          env: {
            ...process.env,
            KIA_EXT_HOST_CHILD: '1',
            TS_NODE_TRANSPILE_ONLY: '1',
            TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
          },
        });
      },
      onChange: () => {},
      hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
    });
    await platform.start();
  });

  afterAll(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Installs a fixture through the real preview/commit gate. */
  async function install(dir: string, id: string): Promise<void> {
    const preview = await platform.installPreview(dir);
    expect(preview).toMatchObject({ ok: true, id });
    await expect(
      platform.installCommit((preview as { token: string }).token),
    ).resolves.toEqual({ ok: true, id });
  }

  const engineFor = () =>
    createEngine({
      store,
      sources: {
        get: (id: string) => registry.get(id),
        list: () => [],
        register: () => {},
      } as never,
      inference: noInference as never,
      convert: async (d) => d,
      logs: { log: () => {} },
      refreshers: new Map(),
    });

  const noAuth = {
    prompt: async () => ({}),
    oauth: async () => ({}),
    showQr: () => {},
    status: () => {},
  } as never as AuthChannel;

  it('carries metadata.outbound from the child toDocument through draft_reply back to the extension sender', async () => {
    const forksBefore = forks;
    await install(SENDER_FIXTURE, 'test.sender');
    expect(forks).toBe(forksBefore + 1); // a REAL child, not the in-process tier
    expect(registry.has('fixsrc')).toBe(true);
    expect(senderRegistry.has('fixsrc')).toBe(true);

    const engine = engineFor();
    const account = await engine.connect(registry.get('fixsrc')!, noAuth);
    const handle = engine.run(account);
    await waitUntil(
      async () => (await store.read.count({ account: account.id })) > 0,
    );
    await handle.stop();

    // PRODUCER END: the hook the child's toDocument wrote survived the wire
    // and is on the stored document, structure intact.
    const [doc] = await store.read.search({ account: account.id });
    expect(doc.metadata.outbound).toEqual({
      ref: { room: 'fixroom', item: 0 },
      display: 'fixroom (item 0)',
      targets: [
        {
          key: 'm0a',
          ref: { room: 'fixroom', item: 0, msg: 'a' },
          display: 'fixroom (thread on message a)',
        },
        {
          key: 'm0b',
          ref: { room: 'fixroom', item: 0, msg: 'b' },
          display: 'fixroom (thread on message b)',
        },
      ],
    });

    const svc = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: senderRegistry,
      logSink: { log: () => {} },
    });
    svc.setBaseUrl('http://127.0.0.1:7421');
    const tokenOf = (r: { confirm_url?: string }) =>
      r.confirm_url!.split('/outbox/confirm/')[1];
    // What the child's sender actually received, read back OUT of the child.
    // The send count rides along because `lastIntent` is sticky: without it,
    // "the sender got this ref" and "the sender was never called and this is
    // the previous send's ref" are the same observation.
    const lastSend = async () =>
      (await tools.get('sender_last_intent')!.call({})) as {
        intent: { outboundRef?: unknown } | null;
        sends: number;
      };

    // CONSUMER END, default: no target → the document's own ref/display.
    const dflt = await svc.draftReply({
      documentId: doc.id as string,
      body: 'on it',
    });
    expect(dflt.recipient_display).toBe('fixroom (item 0)');
    expect(await svc.confirmByToken(tokenOf(dflt))).toMatchObject({
      kind: 'sent',
    });
    // Still the structured object the source wrote — not the JSON string the
    // outbox column stores, and not a re-parsed near-miss.
    expect(await lastSend()).toEqual({
      intent: expect.objectContaining({
        outboundRef: { room: 'fixroom', item: 0 },
      }),
      sends: 1,
    });

    // CONSUMER END, per-message: a target KEY resolves to that entry's ref.
    const targeted = await svc.draftReply({
      documentId: doc.id as string,
      body: 'threaded',
      target: 'm0b',
    });
    expect(targeted.recipient_display).toBe('fixroom (thread on message b)');
    expect(await svc.confirmByToken(tokenOf(targeted))).toMatchObject({
      kind: 'sent',
    });
    expect(await lastSend()).toEqual({
      intent: expect.objectContaining({
        outboundRef: { room: 'fixroom', item: 0, msg: 'b' },
      }),
      sends: 2, // a SECOND real invocation, not the first one's stale state
    });

    // ...and a key the document does not list is refused before any row.
    await expect(
      svc.draftReply({
        documentId: doc.id as string,
        body: 'x',
        target: 'nope',
      }),
    ).rejects.toThrow(/matches none of the reply targets/);
  });

  it("drives the account to needsReauth from a child's plain code:'auth' Error", async () => {
    const forksBefore = forks;
    await install(AUTHFAIL_FIXTURE, 'test.authfail');
    expect(forks).toBe(forksBefore + 1); // the error must cross a real wire
    const source = registry.get('authfailsrc');
    expect(source).toBeDefined();

    const engine = engineFor();
    const account = await engine.connect(source!, noAuth);
    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    // Settles on its own — 'auth' means STOP, so no abort and no retry loop.
    await waitUntil(() => !handle.active());

    const fresh = await store.account(account.id);
    expect(fresh?.status).toBe('needsReauth');
    expect(fresh?.lastError).toContain('token revoked');
  });
});
