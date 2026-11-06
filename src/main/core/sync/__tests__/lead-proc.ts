/** The writer worker's lead procs, run in-process on a test connection: the
 *  real `promote.ts` functions behind the names the service calls. */
import type BetterSqlite3 from 'better-sqlite3';

import { demote, lead } from '../promote';

export const leadProc =
  (conn: () => BetterSqlite3.Database) =>
  async (name: string, args: unknown): Promise<unknown> => {
    const a = args as {
      epoch: number;
      relayImported?: boolean;
      masterDeviceId: string;
    };
    if (name === 'syncLead')
      return lead(conn(), a.epoch, { relayImported: a.relayImported });
    if (name === 'syncOpen') {
      conn().prepare(`UPDATE sync_state SET head_pending = 0`).run();
      return null;
    }
    if (name === 'syncDemote') {
      demote(conn(), a.masterDeviceId);
      return null;
    }
    return null;
  };
