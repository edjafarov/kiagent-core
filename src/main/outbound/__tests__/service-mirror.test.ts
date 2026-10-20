import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  DraftContent,
  DraftMirror,
  DraftReadResult,
  DraftRef,
  Prefs,
  Sender,
  SendIntent,
} from '@shared/contracts';

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import { OUTBOX_PENDING_CAP } from '../../core/store/outbox';
import { createOutboundService, type OutboundService } from '../service';
import { createAttachments } from '../attachments';
import { shapeOutboundError } from '../error-copy';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function fakePrefs(): Prefs {
  const p = {} as unknown as ReturnType<Prefs['get']>;
  return { get: () => p, patch: async () => {}, onChange: () => () => {} };
}

/** An in-memory provider: drafts by id, with knobs for failures. */
function fakeProvider() {
  const drafts = new Map<string, DraftContent>();
  let n = 0;
  const p = {
    drafts,
    createImpl: null as null | ((i: SendIntent) => Promise<DraftRef>),
    created: [] as SendIntent[],
    patches: [] as unknown[],
    readImpl: null as null | ((r: DraftRef) => Promise<DraftReadResult>),
    updateImpl: null as null | (() => Promise<void>),
    sendImpl: null as null | (() => Promise<{ externalMessageId: string }>),
    removeFails: false,
    calls: [] as string[],
    mirror: null as unknown as DraftMirror,
  };
  p.mirror = {
    async create(intent) {
      p.calls.push('create');
      p.created.push(intent);
      if (p.createImpl) return p.createImpl(intent);
      const id = `d${++n}`;
      drafts.set(id, {
        to: intent.to ?? [],
        cc: intent.cc ?? [],
        bcc: intent.bcc ?? [],
        subject: intent.subject ?? null,
        bodyText: intent.bodyMarkdown,
        attachments: (intent.attachments ?? []).map((a) => ({
          filename: a.filename,
          mime: a.mime,
          size: Buffer.from(a.contentBase64, 'base64').length,
        })),
      });
      return { accountId: intent.accountId, id, threadId: 't1' };
    },
    async update(ref, patch) {
      p.calls.push('update');
      p.patches.push(patch);
      if (p.updateImpl) await p.updateImpl();
      const c = drafts.get(ref.id)!;
      const removed = new Set(patch.removeAttachments ?? []);
      const files = [
        ...c.attachments.filter((a) => !removed.has(a.filename)),
        ...(patch.attachments ?? []).map((a) => ({
          filename: a.filename,
          mime: a.mime,
          size: Buffer.from(a.contentBase64, 'base64').length,
        })),
      ];
      drafts.set(ref.id, {
        ...c,
        ...(patch.to ? { to: patch.to } : {}),
        ...(patch.cc ? { cc: patch.cc } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.bodyMarkdown !== undefined
          ? { bodyText: patch.bodyMarkdown }
          : {}),
        attachments: files,
      });
      return ref;
    },
    async read(ref) {
      p.calls.push('read');
      if (p.readImpl) return p.readImpl(ref);
      const c = drafts.get(ref.id);
      return c ? { state: 'draft', ref, content: c } : { state: 'gone' };
    },
    async remove(ref) {
      p.calls.push('remove');
      if (p.removeFails) throw new Error('offline');
      drafts.delete(ref.id);
    },
    async send(ref) {
      p.calls.push('send');
      if (p.sendImpl) return p.sendImpl();
      drafts.delete(ref.id);
      return { externalMessageId: `sent-${ref.id}` };
    },
  };
  return p;
}

describe('outbound service — provider draft mirror', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let service: OutboundService;
  let provider: ReturnType<typeof fakeProvider>;
  let sendMock: jest.Mock;
  let now: number;
  let home: string;

  const make = (
    withDrafts = true,
    wrap: (a: ReturnType<typeof createAttachments>) => typeof a = (a) => a,
  ) => {
    const sender: Sender = {
      send: sendMock,
      ...(withDrafts ? { drafts: provider.mirror } : {}),
    };
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([
        ['gmail', sender],
        ['ms365', { send: sendMock, drafts: provider.mirror }],
        ['slack', { send: sendMock }],
      ]),
      descriptorFor: (id) =>
        (id === 'ms365' ? { compose: 'email' } : undefined) as never,
      attachments: wrap(
        createAttachments({
          documentBytes: { fetchBytes: async () => null },
          home,
        }),
      ),
      logSink: { log: () => {} },
      nowMs: () => now,
    });
    service.setBaseUrl('http://127.0.0.1:7421');
  };

  const draft = (body = 'Hello Bob') =>
    service.draftMessage({
      accountId,
      to: ['bob@example.com'],
      subject: 'Hi',
      body,
    });
  const row = (id: string) => store.outbox.get(id);

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outmirror-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    });
    accountId = account.id;
    provider = fakeProvider();
    sendMock = jest.fn(async () => ({ externalMessageId: '<plain@x>' }));
    now = Date.now();
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kia-home-')));
    fs.writeFileSync(path.join(home, 'a.pdf'), '%PDF-a');
    fs.writeFileSync(path.join(home, 'b.txt'), 'bee');
    make();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('create on draft', () => {
    it('creates, reads back and stores the ref before the tool returns', async () => {
      const r = await draft();
      expect(r.revision).toBe(1);
      expect(provider.calls).toEqual(['create', 'read']);
      expect((await row(r.draft_id))?.mirror).toEqual({
        ref: { accountId, id: 'd1', threadId: 't1' },
        provider: 'Gmail',
      });
    });

    it('a failed create leaves the row Outbox-only with the reason', async () => {
      provider.createImpl = async () => {
        throw new Error('Reconnect this account in Settings to sync drafts');
      };
      const r = await draft();
      expect(r.revision).toBe(1);
      expect((await row(r.draft_id))?.mirror).toEqual({
        ref: null,
        error: 'Reconnect this account in Settings to sync drafts',
        provider: 'Gmail',
      });
    });

    it('a create that hangs past 20 s leaves the row Outbox-only; the tool still returns', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      provider.createImpl = () => new Promise(() => {});
      const pending = draft();
      await jest.advanceTimersByTimeAsync(20_001);
      const r = await pending;
      expect((await row(r.draft_id))?.mirror).toEqual({
        ref: null,
        error: 'draft create timed out',
        provider: 'Gmail',
      });
    });

    it('a create that lands after the deadline is removed again', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      let land: (r: DraftRef) => void = () => {};
      provider.createImpl = () =>
        new Promise((resolve) => {
          land = resolve;
        });
      const pending = draft();
      await jest.advanceTimersByTimeAsync(20_001);
      await pending;
      land({ accountId, id: 'late' });
      await jest.advanceTimersByTimeAsync(0);
      expect(provider.calls).toContain('remove');
    });

    it('a new draft that reads back as missing stays a pending, synced draft', async () => {
      provider.readImpl = async () => ({ state: 'gone' });
      const r = await draft();
      const got = await row(r.draft_id);
      expect(got?.status).toBe('draft');
      expect(got?.mirror?.ref?.id).toBe('d1');
    });

    it('the pending cap refuses before the provider is asked', async () => {
      make(false);
      for (let i = 0; i < OUTBOX_PENDING_CAP; i++) await draft(`n${i}`);
      make();
      await expect(draft()).rejects.toThrow();
      expect(provider.calls).toEqual([]);
    });

    it('accounts whose sender keeps no drafts are never mirrored', async () => {
      make(false);
      const r = await draft();
      expect((await row(r.draft_id))?.mirror).toBeNull();
    });
  });

  describe('refresh', () => {
    it('adopts a body changed in the provider as a new revision', async () => {
      const r = await draft();
      provider.drafts.get('d1')!.bodyText = 'Edited in Gmail';
      const [item] = await service.listOutbox({});
      expect(item.revision).toBe(2);
      expect(item.draft?.body).toBe('Edited in Gmail');
      expect((await row(r.draft_id))?.revision).toBe(2);
    });

    it('a whitespace-only difference is no new revision but refreshes the ref', async () => {
      const r = await draft();
      provider.readImpl = async (ref) => ({
        state: 'draft',
        ref: { ...ref, threadId: 't2' },
        content: { ...provider.drafts.get('d1')!, bodyText: 'Hello Bob  \r\n' },
      });
      await service.listOutbox({});
      const got = await row(r.draft_id);
      expect(got?.revision).toBe(1);
      expect(got?.mirror?.ref?.threadId).toBe('t2');
    });

    it('a draft Gmail re-saved on open (names added, text re-wrapped) is no new revision', async () => {
      const r = await draft(
        'A line long enough that Gmail wraps it when the draft is opened there.',
      );
      const d = provider.drafts.get('d1')!;
      provider.drafts.set('d1', {
        ...d,
        to: ['Bob Example <Bob@Example.com>'],
        bodyText:
          'A line long enough that Gmail wraps it when the draft is\nopened there.\n',
      });
      await service.listOutbox({});
      expect((await row(r.draft_id))?.revision).toBe(1);
      // A real edit there still counts.
      provider.drafts.get('d1')!.bodyText = 'Shorter, from Gmail.';
      await service.listOutbox({});
      expect((await row(r.draft_id))?.revision).toBe(2);
    });

    it('sent in the provider → sent, marked sent elsewhere', async () => {
      const r = await draft();
      provider.readImpl = async () => ({
        state: 'sent',
        externalMessageId: 'm1',
      });
      await service.listOutbox({});
      const got = await row(r.draft_id);
      expect(got?.status).toBe('sent');
      expect(got?.mirror?.sentElsewhere).toBe(true);
      expect(got?.externalMessageId).toBe('m1');
    });

    it('deleted in the provider → discarded', async () => {
      const r = await draft();
      provider.readImpl = async () => ({ state: 'deleted' });
      await service.listOutbox({});
      expect(await row(r.draft_id)).toMatchObject({
        status: 'discarded',
        error: 'Deleted in Gmail',
      });
    });

    it('gone from Drafts → delivery unknown, never claiming either', async () => {
      const r = await draft();
      provider.drafts.clear();
      await service.listOutbox({});
      expect(await row(r.draft_id)).toMatchObject({
        status: 'delivery_unknown',
        error:
          'No longer in Drafts — sent from Gmail or deleted there; check Sent',
      });
    });

    it('a listing whose refresh fails or hangs renders the row as it was, within ~5 s', async () => {
      const r = await draft();
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      provider.readImpl = () => new Promise(() => {});
      const pending = service.listOutbox({});
      await jest.advanceTimersByTimeAsync(5_001);
      const [item] = await pending;
      expect(item.draft_id).toBe(r.draft_id);
      expect(item.revision).toBe(1);
      jest.useRealTimers();
      provider.readImpl = async () => {
        throw new Error('offline');
      };
      const [again] = await service.listOutbox({});
      expect(again.status).toBe('draft');
    });

    it('a refresh that finds nothing new is no change event', async () => {
      await draft();
      const events = jest.fn();
      const off = store.outbox.onChange(events);
      await service.listOutbox({});
      await service.listOutbox({});
      off();
      expect(events).not.toHaveBeenCalled();
    });

    it('concurrent refreshes of one draft share one read', async () => {
      const r = await draft();
      provider.calls = [];
      await Promise.all([
        service.refreshById(r.draft_id),
        service.refreshById(r.draft_id),
        service.listOutbox({}),
      ]);
      expect(provider.calls.filter((c) => c === 'read')).toHaveLength(1);
    });

    it('a review refresh never waits out a long write on the lock', async () => {
      const r = await draft();
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      provider.updateImpl = () => new Promise(() => {});
      void service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'x' });
      const pending = service.refreshById(r.draft_id);
      await jest.advanceTimersByTimeAsync(20_001);
      expect((await pending)?.revision).toBe(1);
    });

    it('listing and review surfaces never retry a failed create', async () => {
      provider.createImpl = async () => {
        throw new Error('offline');
      };
      const r = await draft();
      provider.createImpl = null;
      provider.calls = [];
      await service.listOutbox({});
      await service.refreshById(r.draft_id);
      expect(provider.calls).toEqual([]);
    });
  });

  describe('revise', () => {
    it("Kia's own edit of line breaks alone is kept, and can be undone", async () => {
      const r = await draft();
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        body: 'Hello\nBob',
      });
      expect(v.revision).toBe(2);
      expect((await row(r.draft_id))?.bodyMarkdown).toBe('Hello\nBob');
      const back = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 2,
        body: 'Hello Bob',
      });
      expect(back.revision).toBe(3);
      expect(provider.drafts.get('d1')?.bodyText).toBe('Hello Bob');
    });

    it('sends the edit to the provider and adopts the readback: one bump', async () => {
      const r = await draft();
      provider.calls = [];
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        body: 'Shorter',
      });
      expect(v.revision).toBe(2);
      expect(provider.drafts.get('d1')?.bodyText).toBe('Shorter');
      expect(provider.calls).toEqual(['read', 'update', 'read']);
    });

    it('a change made in the provider first makes the revise stale', async () => {
      const r = await draft();
      provider.drafts.get('d1')!.bodyText = 'Edited in Gmail';
      await expect(
        service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'x' }),
      ).rejects.toThrow(/this draft changed[\s\S]*Edited in Gmail/);
      expect(provider.drafts.get('d1')?.bodyText).toBe('Edited in Gmail');
    });

    it('a slow provider update is waited for, never abandoned', async () => {
      const r = await draft();
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      provider.updateImpl = () =>
        new Promise((resolve) => setTimeout(resolve, 45_000));
      const pending = service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        body: 'Slow',
      });
      await jest.advanceTimersByTimeAsync(45_001);
      const v = await pending;
      expect(v.revision).toBe(2);
      expect(provider.drafts.get('d1')?.bodyText).toBe('Slow');
    });

    it('a failed provider update refuses and changes nothing', async () => {
      const r = await draft();
      provider.updateImpl = async () => {
        throw new Error('503');
      };
      await expect(
        service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'x' }),
      ).rejects.toThrow(
        /couldn't update the Gmail draft \(503\)[\s\S]*try again/,
      );
      expect((await row(r.draft_id))?.revision).toBe(1);
    });

    it('an Outbox-only row on a mirroring account retries the create: one bump', async () => {
      provider.createImpl = async () => {
        throw new Error('offline');
      };
      const r = await draft();
      provider.createImpl = null;
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        body: 'Shorter',
      });
      expect(v.revision).toBe(2);
      const got = await row(r.draft_id);
      expect(got?.mirror?.ref?.id).toBe('d1');
      expect(provider.drafts.get('d1')?.bodyText).toBe('Shorter');
    });
  });

  describe('send', () => {
    it('a mirrored row is sent as the provider draft, never re-composed', async () => {
      const r = await draft();
      const out = await service.sendById(r.draft_id, 1);
      expect(out.kind).toBe('sent');
      expect(provider.calls).toContain('send');
      expect(sendMock).not.toHaveBeenCalled();
      expect((await row(r.draft_id))?.externalMessageId).toBe('sent-d1');
    });

    it('the confirm reads the provider first: an edit there means review again', async () => {
      const r = await draft();
      provider.drafts.get('d1')!.bodyText = 'Edited in Gmail';
      const out = await service.sendById(r.draft_id, 1);
      expect(out.kind).toBe('changed');
      expect(provider.calls).not.toContain('send');
    });

    it('an unreachable provider refuses the send, provably unsent; the row stays a draft', async () => {
      const r = await draft();
      provider.readImpl = async () => {
        throw new Error('ETIMEDOUT');
      };
      const out = await service.sendById(r.draft_id, 1);
      expect(out).toMatchObject({
        kind: 'failed',
        error: "not sent: couldn't reach Gmail — try again",
      });
      expect(
        shapeOutboundError((out as { error: string }).error).canRetry,
      ).toBe(true);
      const got = await row(r.draft_id);
      expect(got?.status).toBe('draft');
      expect(got?.revision).toBe(1);
      expect(provider.calls).not.toContain('send');
      expect(sendMock).not.toHaveBeenCalled();
      // Send again once it is back: same revision, same provider draft.
      provider.readImpl = null;
      expect((await service.sendById(r.draft_id, 1)).kind).toBe('sent');
      expect(provider.calls).toContain('send');
    });

    it('an Outbox-only row sends as today and never tries the create', async () => {
      provider.createImpl = async () => {
        throw new Error('offline');
      };
      const r = await draft();
      provider.calls = [];
      expect((await service.sendById(r.draft_id, 1)).kind).toBe('sent');
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(provider.calls).toEqual([]);
    });

    it('an ambiguous provider send stays terminal', async () => {
      const r = await draft();
      provider.sendImpl = async () => {
        throw new Error('gmail 503 https://x socket hang up');
      };
      const out = await service.sendById(r.draft_id, 1);
      expect(out.kind).toBe('failed');
      expect(await service.reopenById(r.draft_id)).toBeNull();
    });
  });

  describe('discard and redraft', () => {
    it('discard removes the provider draft', async () => {
      const r = await draft();
      await service.discardById(r.draft_id);
      expect(provider.drafts.size).toBe(0);
      expect((await row(r.draft_id))?.status).toBe('discarded');
    });

    it('discarding a draft already sent from Gmail records it as sent', async () => {
      const r = await draft();
      provider.readImpl = async () => ({
        state: 'sent',
        externalMessageId: 'm1',
      });
      await service.discardById(r.draft_id);
      expect((await row(r.draft_id))?.status).toBe('sent');
      expect(provider.calls).not.toContain('remove');
    });

    it('a failed remove is logged and the row is still discarded', async () => {
      const r = await draft();
      provider.removeFails = true;
      await service.discardById(r.draft_id);
      expect((await row(r.draft_id))?.status).toBe('discarded');
    });

    it('cancel on the page removes it too', async () => {
      const r = await draft();
      const token = r.confirm_url!.split('/outbox/confirm/')[1];
      expect((await service.cancelByToken(token)).kind).toBe('cancelled');
      expect(provider.drafts.size).toBe(0);
    });

    it('redraft of a failed mirrored row removes its draft and mirrors the new row', async () => {
      const r = await draft();
      provider.sendImpl = async () => {
        throw new Error('gmail 503 https://x socket hang up');
      };
      await service.sendById(r.draft_id, 1);
      provider.sendImpl = null;
      const fresh = await service.redraft(r.draft_id);
      expect(provider.drafts.has('d1')).toBe(false);
      expect(fresh.mirror?.ref?.id).toBe('d2');
    });
  });

  describe('attachments', () => {
    const file = (n: string) => ({ path: path.join(home, n) });
    const withFile = () =>
      service.draftMessage({
        accountId,
        to: ['bob@example.com'],
        subject: 'Hi',
        body: 'See attached',
        attachments: [file('a.pdf')],
      });

    it('a mirrored draft is created first, its files added after; every surface lists them', async () => {
      const r = await withFile();
      expect(provider.created[0].attachments).toBeUndefined();
      expect(provider.calls).toEqual(['create', 'update', 'read']);
      const patch = provider.patches[0] as {
        attachments: { contentBase64: string }[];
      };
      expect(
        Buffer.from(patch.attachments[0].contentBase64, 'base64').toString(),
      ).toBe('%PDF-a');
      expect(r.revision).toBe(1);
      expect(r.attachments).toEqual([
        {
          filename: 'a.pdf',
          size: 6,
          origin: `from ${path.join(home, 'a.pdf')}`,
        },
      ]);
    });

    it("a provider that counts a file's size its own way (Outlook) is no new revision", async () => {
      provider.readImpl = async (ref) => {
        const c = provider.drafts.get(ref.id)!;
        return {
          state: 'draft',
          ref,
          content: {
            ...c,
            attachments: c.attachments.map((a) => ({
              ...a,
              size: a.size + 158,
            })),
          },
        };
      };
      const r = await withFile();
      expect(r.revision).toBe(1);
      await service.listOutbox({});
      const got = await row(r.draft_id);
      expect(got?.revision).toBe(1);
      expect(got?.attachments[0].size).toBe(6);
    });

    it("a draft with files that left its subject to the provider takes the provider's: still revision 1", async () => {
      // Outlook replies with files: no readback at create; the upload's
      // read is the create's read.
      provider.readImpl = async (ref) => ({
        state: 'draft',
        ref,
        content: { ...provider.drafts.get(ref.id)!, subject: 'RE: Hi' },
      });
      // A reply row's null subject, through the same create-with-files path.
      const r = await service.draftMessage({
        accountId,
        to: ['bob@example.com'],
        subject: undefined as unknown as string,
        body: 'See attached',
        attachments: [file('a.pdf')],
      });
      expect(r.revision).toBe(1);
      expect((await row(r.draft_id))?.subject).toBe('RE: Hi');
    });

    it("with no remembered size, a file is Kia's only at Kia's own size", async () => {
      // A row synced before sizes were remembered, or whose upload read failed.
      const forget = async (id: string) => {
        const before = (await row(id))!;
        await store.outbox.setMirror(id, {
          ...before.mirror!,
          sizes: undefined,
        });
      };
      const r = await withFile();
      await forget(r.draft_id);
      // Gmail counts exactly: no new revision, and remembered from here on.
      await service.listOutbox({});
      let got = await row(r.draft_id);
      expect(got?.revision).toBe(1);
      expect(got?.mirror?.sizes).toEqual({ 'a.pdf': 6 });
      // Any other size might be a replaced file: an edit, to be reviewed.
      await forget(r.draft_id);
      const d = provider.drafts.get('d1')!;
      d.attachments = d.attachments.map((a) => ({ ...a, size: 900 }));
      await service.listOutbox({});
      got = await row(r.draft_id);
      expect(got?.revision).toBe(2);
      expect(got?.attachments[0].from).toBeUndefined();
    });

    it('a file replaced in the provider under the same name is an edit', async () => {
      provider.readImpl = async (ref) => {
        const c = provider.drafts.get(ref.id)!;
        return {
          state: 'draft',
          ref,
          content: {
            ...c,
            attachments: c.attachments.map((a) => ({
              ...a,
              size: a.size + 158,
            })),
          },
        };
      };
      const r = await withFile();
      expect(r.revision).toBe(1);
      const d = provider.drafts.get('d1')!;
      d.attachments = d.attachments.map((a) => ({ ...a, size: 900 }));
      await service.listOutbox({});
      const got = await row(r.draft_id);
      expect(got?.revision).toBe(2);
      expect(got?.attachments[0]).toMatchObject({ size: 1058 });
      expect(got?.attachments[0].from).toBeUndefined();
    });

    it("a file replaced in the provider during Kia's own edit is not Kia's", async () => {
      let reads = 0;
      provider.readImpl = async (ref) => {
        const c = provider.drafts.get(ref.id)!;
        reads += 1;
        return {
          state: 'draft',
          ref,
          content: {
            ...c,
            attachments: c.attachments.map((a) => ({
              ...a,
              size: reads > 3 ? 900 : a.size + 158,
            })),
          },
        };
      };
      const r = await withFile();
      // reads: create's file upload read (1); revise: sync (2), then the
      // update's own read (3+).
      reads = 2;
      await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        body: 'Shorter',
      });
      const got = await row(r.draft_id);
      expect(got?.bodyMarkdown).toBe('Shorter');
      expect(got?.attachments[0]).toMatchObject({ size: 900 });
      expect(got?.attachments[0].from).toBeUndefined();
    });

    it('revise adds and removes files on the provider draft in one revision', async () => {
      const r = await withFile();
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        addAttachments: [file('b.txt')],
        removeAttachments: ['a.pdf'],
      });
      expect(v.revision).toBe(2);
      expect(provider.patches[1]).toMatchObject({
        removeAttachments: ['a.pdf'],
        attachments: [{ filename: 'b.txt' }],
      });
      expect(v.attachments.map((a) => a.filename)).toEqual(['b.txt']);
      // where Kia got the file survives the readback
      expect((await row(r.draft_id))?.attachments[0].from).toEqual({
        kind: 'file',
        path: path.join(home, 'b.txt'),
        sha: expect.any(String),
      });
    });

    it('swapping a file for another of the same name and size is still an edit', async () => {
      make(false);
      fs.mkdirSync(path.join(home, 'v2'));
      fs.writeFileSync(path.join(home, 'v2', 'a.pdf'), '%PDF-b');
      const r = await withFile();
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        removeAttachments: ['a.pdf'],
        addAttachments: [file('v2/a.pdf')],
      });
      expect(v.revision).toBe(2);
      await service.sendById(r.draft_id, 2);
      const intent = sendMock.mock.calls[0][0] as SendIntent;
      expect(
        Buffer.from(intent.attachments![0].contentBase64, 'base64').toString(),
      ).toBe('%PDF-b');
    });

    it("a file Kia replaced whose read then failed is judged by Kia's size, not the old one's", async () => {
      fs.mkdirSync(path.join(home, 'v3'));
      fs.writeFileSync(path.join(home, 'v3', 'a.pdf'), 'x'.repeat(900));
      const r = await withFile();
      expect((await row(r.draft_id))?.mirror?.sizes).toEqual({ 'a.pdf': 6 });
      let reads = 0;
      provider.readImpl = async (ref) => {
        reads += 1;
        // revise: its sync read (1) passes, the update's own read (2) fails
        if (reads === 2) throw new Error('read timed out');
        return { state: 'draft', ref, content: provider.drafts.get(ref.id)! };
      };
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        removeAttachments: ['a.pdf'],
        addAttachments: [file('v3/a.pdf')],
      });
      expect(v.revision).toBe(2);
      expect((await row(r.draft_id))?.mirror?.sizes).toBeUndefined();
      // A plain Gmail refresh: the new file at its own size, no new revision.
      await service.listOutbox({});
      let got = await row(r.draft_id);
      expect(got?.revision).toBe(2);
      expect(got?.attachments[0]).toMatchObject({ size: 900 });
      expect(got?.attachments[0].from).toMatchObject({ kind: 'file' });
      // Swapped there for a file of the old file's size: an edit to review.
      const d = provider.drafts.get('d1')!;
      d.attachments = d.attachments.map((a) => ({ ...a, size: 6 }));
      await service.listOutbox({});
      got = await row(r.draft_id);
      expect(got?.revision).toBe(3);
      expect(got?.attachments[0].from).toBeUndefined();
    });

    it('a file swapped for a link out of bounds after it was added is not sent', async () => {
      make(false);
      const r = await withFile();
      fs.mkdirSync(path.join(home, '.ssh'));
      fs.writeFileSync(path.join(home, '.ssh', 'id'), 'KEY');
      fs.rmSync(path.join(home, 'a.pdf'));
      fs.symlinkSync(path.join(home, '.ssh', 'id'), path.join(home, 'a.pdf'));
      const out = await service.sendById(r.draft_id, 1);
      expect(out).toMatchObject({
        kind: 'failed',
        error: expect.stringMatching(
          /^not sent: attachment "a.pdf" (can no longer be attached|changed since it was added)/,
        ),
      });
      expect((await row(r.draft_id))?.status).toBe('draft');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('a file upload that fails leaves a synced draft without it, and says so', async () => {
      provider.updateImpl = async () => {
        throw new Error('upload timed out');
      };
      const r = await withFile();
      const got = await row(r.draft_id);
      expect(got?.mirror?.ref?.id).toBe('d1');
      expect(got?.attachments).toEqual([]);
      expect(r.warnings.join(' ')).toMatch(
        /files were not added to the Gmail draft \(upload timed out\) — add them again/,
      );
    });

    it('a file whose bytes changed since it was added is not sent', async () => {
      make(false);
      const r = await withFile();
      fs.writeFileSync(path.join(home, 'a.pdf'), '%PDF-X');
      const out = await service.sendById(r.draft_id, 1);
      expect(out).toMatchObject({
        kind: 'failed',
        error:
          'not sent: attachment "a.pdf" changed since it was added (~/a.pdf) — add it again',
      });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('re-adding the same path after its bytes changed is an edit', async () => {
      make(false);
      const r = await withFile();
      fs.writeFileSync(path.join(home, 'a.pdf'), '%PDF-X');
      const v = await service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        removeAttachments: ['a.pdf'],
        addAttachments: [file('a.pdf')],
      });
      expect(v.revision).toBe(2);
      expect((await service.sendById(r.draft_id, 2)).kind).toBe('sent');
    });

    it('a duplicate name or an unknown removal is refused', async () => {
      const r = await withFile();
      await expect(
        service.reviseDraft({
          draftId: r.draft_id,
          revision: 1,
          addAttachments: [file('a.pdf')],
        }),
      ).rejects.toThrow(/already on this draft/);
      await expect(
        service.reviseDraft({
          draftId: r.draft_id,
          revision: 1,
          removeAttachments: ['nope.pdf'],
        }),
      ).rejects.toThrow(/no file named "nope.pdf"/);
    });

    it('an unmirrored Gmail send carries the file bytes', async () => {
      make(false);
      const r = await withFile();
      expect((await service.sendById(r.draft_id, 1)).kind).toBe('sent');
      const intent = sendMock.mock.calls[0][0] as SendIntent;
      expect(intent.attachments?.map((a) => a.filename)).toEqual(['a.pdf']);
    });

    it('a file gone at send fails provably unsent, naming it', async () => {
      make(false);
      const r = await withFile();
      fs.rmSync(path.join(home, 'a.pdf'));
      const out = await service.sendById(r.draft_id, 1);
      expect(out).toMatchObject({
        kind: 'failed',
        error: 'not sent: attachment "a.pdf" is no longer available (~/a.pdf)',
      });
      expect(
        shapeOutboundError((out as { error: string }).error).canRetry,
      ).toBe(true);
      // Nothing happened to it: still the draft, at its revision.
      expect((await row(r.draft_id))?.status).toBe('draft');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('a chat source refuses files', async () => {
      const slack = await store.createAccount({
        source: 'slack',
        identifier: 'team',
        config: {},
      });
      await store.commit({
        account: slack.id,
        documents: [
          {
            externalId: 'c1',
            type: 'chat.day',
            title: 'design',
            markdown: 'x',
            metadata: {
              outbound: { ref: { channel: 'c1' }, display: '#design' },
            },
            createdAt: '2026-07-01T00:00:00Z',
          },
        ],
        cursor: null,
      });
      const [doc] = await store.read.search({ limit: 10 });
      await expect(
        service.draftReply({
          documentId: doc.id as string,
          body: 'hi',
          attachments: [file('a.pdf')],
        }),
      ).rejects.toThrow("this source can't send files yet");
    });

    it('a Gmail draft that never synced still sends its files, and does not warn otherwise', async () => {
      provider.createImpl = async () => {
        throw new Error('insufficient scope');
      };
      const r = await withFile();
      expect(r.warnings).toEqual([]);
      const out = await service.sendById(r.draft_id, 1);
      expect(out.kind).toBe('sent');
      const intent = sendMock.mock.calls[0][0] as {
        attachments?: { filename: string }[];
      };
      expect(intent.attachments?.map((a) => a.filename)).toEqual(['a.pdf']);
    });

    it('an Outlook draft that never synced refuses to send its files', async () => {
      const ms = await store.createAccount({
        source: 'ms365',
        identifier: 'me@outlook.com',
        config: {},
      });
      provider.createImpl = async () => {
        throw new Error('offline');
      };
      const r = await service.draftMessage({
        accountId: ms.id,
        to: ['bob@example.com'],
        subject: 'Hi',
        body: 'x',
        attachments: [file('a.pdf')],
      });
      // Said at once, not only at Send.
      expect(r.warnings.join(' ')).toMatch(
        /not synced to Outlook \(offline\), so its files can't be sent yet/,
      );
      const out = await service.sendById(r.draft_id, 1);
      expect(out).toMatchObject({
        kind: 'failed',
        error: 'not sent: files need this draft synced to Outlook first',
      });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('the remote transport cannot attach by path', async () => {
      const { runWithTransport } = await import(
        '../../core/mcp/transport-context'
      );
      service.setRemoteBaseUrl('https://dev.example');
      await expect(
        runWithTransport('remote', () => withFile()),
      ).rejects.toThrow(/document_id/);
    });
  });

  describe('scheduled send', () => {
    const inMin = (m: number) => new Date(now + m * 60_000).toISOString();

    it('schedules at the shown revision; a stale one is changed', async () => {
      const r = await draft();
      expect((await service.scheduleById(r.draft_id, 2, inMin(10))).kind).toBe(
        'changed',
      );
      const out = await service.scheduleById(r.draft_id, 1, inMin(10));
      expect(out.kind).toBe('scheduled');
      expect((await row(r.draft_id))?.sendAt).toBe(inMin(10));
      expect(provider.calls).not.toContain('send');
    });

    it('refuses a time in the past or under a minute away', async () => {
      const r = await draft();
      await expect(
        service.scheduleById(r.draft_id, 1, inMin(0.5)),
      ).rejects.toThrow(/at least a minute/);
    });

    it('a due row is sent at its revision, as the provider draft', async () => {
      const r = await draft();
      await service.scheduleById(r.draft_id, 1, inMin(10));
      now += 10 * 60_000;
      expect(await service.sendScheduled(r.draft_id, inMin(0))).toBe('sent');
      expect(provider.calls).toContain('send');
      expect((await row(r.draft_id))?.status).toBe('sent');
    });

    it('a cancel or reschedule between the pick and the lock wins', async () => {
      const r = await draft();
      const first = inMin(10);
      await service.scheduleById(r.draft_id, 1, first);
      await service.scheduleById(r.draft_id, 1, inMin(20));
      now += 10 * 60_000;
      expect(await service.sendScheduled(r.draft_id, first)).toBe('skipped');
      await service.scheduleById(r.draft_id, 1, null);
      expect((await row(r.draft_id))?.sendAt).toBeNull();
      expect(provider.calls).not.toContain('send');
    });

    it('more than 5 min late is never sent: missed, with a fresh expiry', async () => {
      const r = await draft();
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      now += 16 * 60_000;
      expect(await service.sendScheduled(r.draft_id, at)).toBe('missed');
      const got = await row(r.draft_id);
      expect(got?.status).toBe('draft');
      expect(got?.sendAt).toBeNull();
      expect(got?.error).toBe('Missed its time — send now or reschedule');
      expect(Date.parse(got!.expiresAt)).toBeGreaterThan(now);
      expect(provider.calls).not.toContain('send');
      // Send now clears the note.
      expect((await service.sendById(r.draft_id, 1)).kind).toBe('sent');
      expect((await row(r.draft_id))?.error).toBeNull();
    });

    it('a provider out of reach keeps the row armed; the next tick sends', async () => {
      const r = await draft();
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      now += 10 * 60_000;
      provider.readImpl = async () => {
        throw new Error('offline');
      };
      expect(await service.sendScheduled(r.draft_id, at)).toBe('failed');
      expect((await row(r.draft_id))?.sendAt).toBe(at);
      provider.readImpl = null;
      now += 30_000;
      expect(await service.sendScheduled(r.draft_id, at)).toBe('sent');
    });

    it('an edit (Kia or the provider) clears the schedule and says so', async () => {
      const r = await draft();
      await service.scheduleById(r.draft_id, 1, inMin(10));
      provider.drafts.get('d1')!.bodyText = 'Edited in Gmail';
      await service.refreshById(r.draft_id);
      const got = await row(r.draft_id);
      expect(got?.sendAt).toBeNull();
      expect(got?.error).toBe('Edited — schedule again');
      await service.scheduleById(r.draft_id, 2, inMin(10));
      expect((await row(r.draft_id))?.error).toBeNull();
    });

    it('waits for a sender that is not up yet instead of failing', async () => {
      const ms = await store.createAccount({
        source: 'ms365',
        identifier: 'me@outlook.com',
        config: {},
      });
      const r = await service.draftMessage({
        accountId: ms.id,
        to: ['bob@example.com'],
        subject: 'Hi',
        body: 'x',
      });
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      // the extension's sender has not registered yet
      service = createOutboundService({
        store,
        prefs: fakePrefs(),
        senders: new Map<string, Sender>([['gmail', { send: sendMock }]]),
        logSink: { log: () => {} },
        nowMs: () => now,
      });
      now += 10 * 60_000;
      expect(await service.sendScheduled(r.draft_id, at)).toBe('skipped');
      expect((await row(r.draft_id))?.status).toBe('draft');
    });

    it('a refresh that runs past the 5 minutes is not sent: missed', async () => {
      const r = await draft();
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      now += 10 * 60_000 + 4 * 60_000 + 50_000; // 4 min 50 s late
      provider.readImpl = async (ref) => {
        now += 20_000; // the refresh takes it past 5 min
        return { state: 'draft', ref, content: provider.drafts.get(ref.id)! };
      };
      expect(await service.sendScheduled(r.draft_id, at)).toBe('missed');
      expect(provider.calls).not.toContain('send');
    });

    it('a clock that went back never sends early', async () => {
      const r = await draft();
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      // picked as due, but by the last check the clock reads earlier
      expect(await service.sendScheduled(r.draft_id, at)).toBe('skipped');
      expect((await row(r.draft_id))?.sendAt).toBe(at);
      expect(provider.calls).not.toContain('send');
    });

    it('a due send that can never go as it is stops at once and says why', async () => {
      make(false);
      fs.writeFileSync(path.join(home, 'c.pdf'), '%PDF-c');
      const r = await service.draftMessage({
        accountId,
        to: ['bob@example.com'],
        subject: 'Hi',
        body: 'x',
        attachments: [{ path: path.join(home, 'c.pdf') }],
      });
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      fs.rmSync(path.join(home, 'c.pdf'));
      now += 10 * 60_000;
      expect(await service.sendScheduled(r.draft_id, at)).toBe('missed');
      const got = await row(r.draft_id);
      expect(got?.sendAt).toBeNull();
      expect(got?.error).toBe(
        'Not sent at its time — attachment "c.pdf" is no longer available (~/c.pdf)',
      );
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('a read that runs out of time is tried again while the time holds', async () => {
      let stall = false;
      make(false, (a) => ({
        ...a,
        read: async (x) => {
          if (stall) throw new Error('reading the attachments timed out');
          return a.read(x);
        },
      }));
      const r = await service.draftMessage({
        accountId,
        to: ['bob@example.com'],
        subject: 'Hi',
        body: 'x',
        attachments: [{ path: path.join(home, 'a.pdf') }],
      });
      const at = inMin(10);
      await service.scheduleById(r.draft_id, 1, at);
      stall = true;
      now += 10 * 60_000;
      expect(await service.sendScheduled(r.draft_id, at)).not.toBe('missed');
      const held = await row(r.draft_id);
      expect(held?.status).toBe('draft');
      expect(held?.sendAt).toBe(at);
      stall = false;
      now += 60_000;
      expect(await service.sendScheduled(r.draft_id, at)).toBe('sent');
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it('scheduled rows do not expire', async () => {
      const r = await draft();
      await service.scheduleById(r.draft_id, 1, inMin(60 * 24 * 30));
      now += 60 * 24 * 3600_000;
      await store.outbox.expireOverdue();
      expect((await row(r.draft_id))?.status).toBe('draft');
    });
  });

  it('peek by token shows the provider’s current draft', async () => {
    const r = await draft();
    provider.drafts.get('d1')!.bodyText = 'Edited in Gmail';
    const token = r.confirm_url!.split('/outbox/confirm/')[1];
    const peek = await service.peekByToken(token);
    expect(peek.kind === 'ok' && peek.row.bodyMarkdown).toBe('Edited in Gmail');
  });
});
