/** @jest-environment node */
/* eslint-disable no-await-in-loop, no-console, @typescript-eslint/no-explicit-any */
/** L0 eval — runs only with EVAL_LLAMA_URL set (spec 2026-10-05 L0). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { ACCOUNTS } from './corpus';
import { agentBrief, agentTurn, fixedBrief, fixedTurn, llamaLlm, score } from './harness';
import { BRIEFS, QUESTIONS } from './questions';

const URL = process.env.EVAL_LLAMA_URL;
const OUT = process.env.EVAL_OUT ?? os.tmpdir();
const MODEL = process.env.EVAL_MODEL ?? 'model';
const ONLY = process.env.EVAL_ONLY?.split(',');

(URL ? describe : describe.skip)('L0 agentic local eval', () => {
  jest.setTimeout(3 * 60 * 60 * 1000);
  let dir: string;
  let store: CoreStore;
  const ext = new Map<string, string>(); // externalId → doc id

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-l0-'));
    store = openStore(await openDb(path.join(dir, 'l0.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    for (const a of ACCOUNTS) {
      const acc = await store.createAccount({ source: a.source, identifier: a.identifier });
      await store.commit({ account: acc.id, documents: a.docs, cursor: null });
      for (const d of a.docs) {
        const doc = await store.read.byExternalId(acc.id, d.externalId, d.type);
        if (doc) ext.set(d.externalId, doc.id);
      }
    }
    expect(ext.size).toBe(ACCOUNTS.reduce((n, a) => n + a.docs.length, 0));
  });

  afterAll(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs every question and brief on both paths', async () => {
    const llm = llamaLlm(URL!);
    const q = store.read;
    const rows: any[] = [];
    for (const item of QUESTIONS.filter((x) => !ONLY || ONLY.includes(x.id))) {
      for (const arm of ['fixed', 'agent'] as const) {
        const t =
          arm === 'fixed'
            ? await fixedTurn(llm, q, item.q, item.history)
            : await agentTurn(llm, q, item.q, item.history);
        const s = score(t.answer, item.all, item.none);
        let ok = s.ok;
        let draftOk: boolean | undefined;
        if (item.draft) {
          const want = ext.get(item.draft.thread);
          draftOk = t.drafts.some(
            (d) => d.documentId === want && item.draft!.body.every((g) => g.some((x) => d.body.toLowerCase().includes(x))),
          );
          ok = ok && draftOk;
        }
        rows.push({ kind: 'question', id: item.id, arm, ...s, ok, draftOk, ms: t.ms, path: t.path, calls: t.calls, invented: t.invented, error: t.error, answer: t.answer, raw: t.raw });
        console.log(`${MODEL} ${arm.padEnd(6)} ${ok ? 'PASS' : 'FAIL'} ${item.id} ${t.ms}ms ${t.path} ${t.calls.map((c) => c.name).join(',')}`);
      }
    }
    for (const b of BRIEFS.filter((x) => !ONLY || ONLY.includes(x.id))) {
      const ev = await q.document(ext.get(b.event) as any);
      for (const arm of ['fixed', 'agent'] as const) {
        const t = arm === 'fixed' ? await fixedBrief(llm, q, ev) : await agentBrief(llm, q, ev);
        const s = score(t.answer, b.all, b.none);
        rows.push({ kind: 'brief', id: b.id, arm, ...s, ms: t.ms, path: t.path, calls: t.calls, invented: t.invented, answer: t.answer });
        console.log(`${MODEL} ${arm.padEnd(6)} ${s.ok ? 'PASS' : 'FAIL'} ${b.id} ${t.ms}ms ${t.path}`);
      }
    }
    fs.writeFileSync(path.join(OUT, `l0-${MODEL}.json`), JSON.stringify(rows, null, 2));
  });
});
