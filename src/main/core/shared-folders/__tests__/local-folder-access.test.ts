import type { ExternalRef } from '@shared/contracts';

import { ownLocalFolders } from '../local-folder-access';
import { closeDevices, device, type Device } from './helpers/device';

afterEach(closeDevices);

const addAccount = (d: Device, id: string) =>
  d.db.run(
    `INSERT INTO accounts(id, source, identifier, config, status, created_at)
     VALUES(?, 'local-folder', ?, '{}', 'connecting', 'now')`,
    [id, id],
  );
const addDoc = (d: Device, id: string, account: string, externalId: string) =>
  d.db.run(
    `INSERT INTO documents(id, account_id, external_id, type, content_hash, ingested_at, updated_at)
     VALUES(?, ?, ?, 'file', 'h', 'now', 'now')`,
    [id, account, externalId],
  );
const live = async (d: Device, account: string) =>
  (
    (await d.db.all(`SELECT external_id FROM documents WHERE account_id = ? AND archived_at IS NULL`, [account])) as {
      external_id: string;
    }[]
  ).map((r) => r.external_id);

const host = (deviceId: string | null, calls: { id: string; refs: ExternalRef[] }[] = []) => ({
  accounts: async () => [
    { id: 'mine', source: 'local-folder', ownerDeviceId: 'dev-1', config: {} },
    { id: 'theirs', source: 'local-folder', ownerDeviceId: 'dev-2', config: {} },
    { id: 'unowned', source: 'local-folder', ownerDeviceId: null, config: {} },
    { id: 'mail', source: 'gmail', ownerDeviceId: 'dev-1', config: {} },
    { id: 'broken', source: 'local-folder', ownerDeviceId: 'dev-1', config: 'not a config' },
  ],
  deviceId: () => deviceId,
  roots: (a: { id: string; config?: unknown }) => {
    if (a.id === 'broken') throw new Error('malformed');
    return ['/Users/me/Documents'];
  },
  quiesce: async () => {},
  archive: async (id: string, refs: ExternalRef[]) => void calls.push({ id, refs }),
});

it('lists this device\'s own local-folder accounts, not another device\'s', async () => {
  const joined = await ownLocalFolders(host('dev-1')).accounts();
  expect(joined.map((a) => a.id)).toEqual(['mine', 'unowned']);
  const stranger = await ownLocalFolders(host('dev-3')).accounts();
  expect(stranger.map((a) => a.id)).toEqual(['unowned']);
  const noId = await ownLocalFolders(host(null)).accounts();
  expect(noId.map((a) => a.id)).toEqual(['unowned']);
});

it('the migration leaves another Mac\'s documents at the same absolute path alone', async () => {
  const sorted = '/Users/me/Documents/Scans/Sorted';
  const calls: { id: string; refs: ExternalRef[] }[] = [];
  const lf = ownLocalFolders({
    ...host('dev-1', calls),
    archive: async (id, refs) => {
      calls.push({ id, refs });
      for (const r of refs)
        await d.db.run(`UPDATE documents SET archived_at = 'now' WHERE account_id = ? AND external_id = ?`, [id, r.externalId]);
    },
  });
  const d = await device('leader', { localFolders: lf });
  for (const id of ['mine', 'theirs']) await addAccount(d, id);
  await addDoc(d, 'd1', 'mine', `${sorted}/a.pdf`);
  await addDoc(d, 'd2', 'theirs', `${sorted}/a.pdf`);
  await d.svc.setRoots({ incoming: null, sorted });
  expect(await live(d, 'mine')).toEqual([]);
  expect(await live(d, 'theirs')).toEqual([`${sorted}/a.pdf`]);
  expect(calls.map((c) => c.id)).toEqual(['mine']);
});
