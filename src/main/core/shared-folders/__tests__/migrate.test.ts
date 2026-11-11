import type { ExternalRef } from '@shared/contracts';

import { closeDevices, device, type Device } from './helpers/device';
import type { LocalFolderAccess } from '../migrate';

afterEach(closeDevices);

const addAccount = (d: Device, id: string, source = 'local-folder') =>
  d.db.run(
    `INSERT INTO accounts(id, source, identifier, config, status, created_at)
     VALUES(?, ?, ?, '{}', 'connecting', 'now')`,
    [id, source, id],
  );
let n = 0;
const addDoc = (d: Device, account: string, externalId: string, type = 'file', archived = false) =>
  d.db.run(
    `INSERT INTO documents(id, account_id, external_id, type, content_hash, ingested_at, updated_at, archived_at)
     VALUES(?, ?, ?, ?, 'h', 'now', 'now', ?)`,
    [`doc-${(n += 1)}`, account, externalId, type, archived ? 'then' : null],
  );
const live = async (d: Device, account: string) =>
  (
    (await d.db.all(
      `SELECT external_id FROM documents WHERE account_id = ? AND archived_at IS NULL ORDER BY external_id`,
      [account],
    )) as { external_id: string }[]
  ).map((r) => r.external_id);

async function withAccess(roots: string[], fail = false, extra: { id: string; roots: string[] }[] = []) {
  const holder = { db: null as unknown as Device, calls: [] as { account: string; refs: ExternalRef[] }[], order: [] as string[], fail };
  const lf: LocalFolderAccess = {
    accounts: async () => [{ id: 'lf', roots }, ...extra],
    quiesce: async (id) => void holder.order.push(`quiesce:${id}`),
    archive: async (id, refs) => {
      holder.order.push(`archive:${id}`);
      if (holder.fail) throw new Error('engine is busy');
      holder.calls.push({ account: id, refs });
      for (const r of refs)
        await holder.db.db.run(`UPDATE documents SET archived_at = 'now' WHERE account_id = ? AND external_id = ? AND type = ?`, [
          id,
          r.externalId,
          r.type,
        ]);
    },
  };
  const d = await device('leader', { localFolders: lf, watch: () => ({ close: async () => {} }) });
  holder.db = d;
  await addAccount(d, 'lf');
  for (const e of extra) await addAccount(d, e.id);
  return { d, holder };
}

it('archives exactly the documents under the root, by ref, for the account that covers it', async () => {
  const home = '/Users/me/Documents';
  const sorted = `${home}/Scans/Sorted`;
  const { d, holder } = await withAccess([home], false, [{ id: 'other', roots: ['/elsewhere'] }]);
  await addDoc(d, 'lf', `${sorted}/a.pdf`);
  await addDoc(d, 'lf', `${sorted}/Tax/b.txt`);
  await addDoc(d, 'lf', `${sorted}/Tax/b.txt`, 'email.message'); // a container child with the same id, other type
  await addDoc(d, 'lf', `${sorted} 2/c.pdf`); // a neighbour that shares the prefix
  await addDoc(d, 'lf', `${home}/Scans/x.pdf`); // a sibling
  await addDoc(d, 'lf', `${sorted}/gone.pdf`, 'file', true); // already archived
  await addDoc(d, 'other', `${sorted}/a.pdf`); // another account that does not track it
  await d.svc.setRoots({ incoming: null, sorted });
  expect(await live(d, 'lf')).toEqual([`${sorted} 2/c.pdf`, `${home}/Scans/x.pdf`]);
  expect(await live(d, 'other')).toEqual([`${sorted}/a.pdf`]);
  expect(holder.calls.flatMap((p) => p.refs).map((r) => `${r.type}:${r.externalId}`).sort()).toEqual([
    `email.message:${sorted}/Tax/b.txt`,
    `file:${sorted}/Tax/b.txt`,
    `file:${sorted}/a.pdf`,
  ]);
});

it('a second setRoots archives nothing more; the move is recorded once per account and root', async () => {
  const root = '/Users/me/Sorted';
  const { d, holder } = await withAccess(['/Users/me']);
  await addDoc(d, 'lf', `${root}/a.pdf`);
  await d.svc.setRoots({ incoming: null, sorted: root });
  expect(holder.calls).toHaveLength(1);
  await addDoc(d, 'lf', `${root}/late.pdf`); // would only appear if something indexed it again
  await d.svc.setRoots({ incoming: null, sorted: root });
  await d.restart();
  await d.svc.setRoots({ incoming: null, sorted: root });
  expect(holder.calls).toHaveLength(1);
  expect(await live(d, 'lf')).toEqual([`${root}/late.pdf`]);
  expect(
    await d.db.all(`SELECT key FROM meta WHERE key LIKE 'shared-folders:migrated:%'`),
  ).toEqual([{ key: `shared-folders:migrated:lf:${root}` }]);
});

it('goes in pages of at most 1000 refs', async () => {
  const root = '/Users/me/Sorted';
  const { d, holder } = await withAccess(['/Users/me']);
  const steps = [];
  for (let i = 0; i < 2300; i += 1)
    steps.push({
      sql: `INSERT INTO documents(id, account_id, external_id, type, content_hash, ingested_at, updated_at)
            VALUES(?, 'lf', ?, 'file', 'h', 'now', 'now')`,
      params: [`bulk-${i}`, `${root}/f${String(i).padStart(5, '0')}.txt`],
    });
  await d.db.batch(steps);
  await d.svc.setRoots({ incoming: null, sorted: root });
  expect(holder.calls.map((c) => c.refs.length)).toEqual([1000, 1000, 300]);
  expect(await live(d, 'lf')).toEqual([]);
});

it('an account that does not track the folder is left alone', async () => {
  const { d, holder } = await withAccess(['/Volumes/Other']);
  await addDoc(d, 'lf', '/Users/me/Sorted/a.pdf');
  await d.svc.setRoots({ incoming: null, sorted: '/Users/me/Sorted' });
  expect(holder.calls).toEqual([]);
  expect(await live(d, 'lf')).toHaveLength(1);
});

it('an account whose own root lies inside the shared folder is migrated too', async () => {
  const { d, holder } = await withAccess(['/Users/me/Sorted/Tax']);
  await addDoc(d, 'lf', '/Users/me/Sorted/Tax/a.pdf');
  await d.svc.setRoots({ incoming: null, sorted: '/Users/me/Sorted' });
  expect(holder.calls).toHaveLength(1);
});

it('a failure is logged, not recorded, and retried the next time the roots are set', async () => {
  const root = '/Users/me/Sorted';
  const { d, holder } = await withAccess(['/Users/me'], true);
  await addDoc(d, 'lf', `${root}/a.pdf`);
  await d.svc.setRoots({ incoming: null, sorted: root });
  expect(d.logs.some((l) => l.includes('engine is busy'))).toBe(true);
  expect(await d.db.all(`SELECT key FROM meta WHERE key LIKE 'shared-folders:migrated:%'`)).toEqual([]);
  expect(await live(d, 'lf')).toHaveLength(1);
  holder.fail = false;
  await d.svc.setRoots({ incoming: null, sorted: root });
  expect(await live(d, 'lf')).toEqual([]);
});

it('both roots are migrated, each recorded on its own', async () => {
  const { d, holder } = await withAccess(['/Users/me']);
  await addDoc(d, 'lf', '/Users/me/In/a.pdf');
  await addDoc(d, 'lf', '/Users/me/Sorted/b.pdf');
  await d.svc.setRoots({ incoming: '/Users/me/In', sorted: '/Users/me/Sorted' });
  expect(holder.calls.flatMap((c) => c.refs.map((r) => r.externalId)).sort()).toEqual([
    '/Users/me/In/a.pdf',
    '/Users/me/Sorted/b.pdf',
  ]);
});

it('the local-folder loop is quiesced before anything is looked for, even with nothing under the root yet', async () => {
  const root = '/Users/me/Sorted';
  const { d, holder } = await withAccess(['/Users/me']);
  const real = d.db.all.bind(d.db);
  const spy = jest.spyOn(d.db, 'all').mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/FROM documents/.test(sql)) holder.order.push('query');
    if (/FROM meta WHERE key/.test(sql)) holder.order.push('check');
    return real(sql, params as never);
  });
  const run = d.db.run.bind(d.db);
  jest.spyOn(d.db, 'run').mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/shared-folders:migrated|migrated/.test(String(params?.[0] ?? '')) || /INSERT OR IGNORE INTO meta/.test(sql)) holder.order.push('done');
    return run(sql, params as never);
  });
  await d.svc.setRoots({ incoming: null, sorted: root });
  spy.mockRestore();
  expect(holder.order.filter((o) => o !== 'check')).toEqual(['quiesce:lf', 'query', 'done']);
});
