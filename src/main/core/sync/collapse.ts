/** Folds the per-device rows of a formerly device-owned source back into one
 *  account-level row (spec 2026-11-15-account-level-assistant §3.2). Runs on
 *  the writer before accounts start; a follower gets the result by sync. */
import type { AccountId } from '@shared/contracts';

import { baseIdentifier, FORMERLY_DEVICE_OWNED } from './sources';

export interface CollapseRow {
  id: string;
  source: string;
  identifier: string;
  ownerDeviceId: string | null;
  createdAt: string;
  docs: number;
}

export interface CollapsePlan {
  remove: string[];
  rename: { id: string; identifier: string }[];
}

const clean = (r: CollapseRow): boolean =>
  r.identifier === baseIdentifier(r.identifier) && r.ownerDeviceId === null;

/** Keeper: most documents, then the bare identifier, then the oldest, then
 *  the smallest id. Documents first: a bare `local` can be a fresh empty seed
 *  that landed before this ran. */
function keeperOf(group: CollapseRow[]): CollapseRow {
  return [...group].sort((a, b) => {
    if (a.docs !== b.docs) return b.docs - a.docs;
    const ab = a.identifier === baseIdentifier(a.identifier) ? 0 : 1;
    const bb = b.identifier === baseIdentifier(b.identifier) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

export function planCollapse(rows: readonly CollapseRow[]): CollapsePlan {
  const plan: CollapsePlan = { remove: [], rename: [] };
  const groups = new Map<string, CollapseRow[]>();
  for (const r of rows) {
    if (!FORMERLY_DEVICE_OWNED.includes(r.source)) continue;
    const key = `${r.source}\u0000${baseIdentifier(r.identifier)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  for (const group of groups.values()) {
    if (group.length === 1 && clean(group[0])) continue;
    const keeper = keeperOf(group);
    for (const r of group) if (r.id !== keeper.id) plan.remove.push(r.id);
    if (!clean(keeper))
      plan.rename.push({
        id: keeper.id,
        identifier: baseIdentifier(keeper.identifier),
      });
  }
  return plan;
}

export interface CollapseDeps {
  db: { all(sql: string, params?: unknown[]): Promise<unknown[]> };
  store: {
    commit(batch: {
      renameAccount: { id: AccountId; identifier: string };
    }): Promise<unknown>;
  };
  /** The user's Remove: stops a running loop, drops the account and its
   *  documents, unregisters its jobs. */
  remove(id: AccountId): Promise<void>;
}

/** Reads, plans, removes, then renames. Not one transaction: every step is
 *  idempotent and the next resume finishes a run cut short. */
export async function collapseFormerlyOwned(
  deps: CollapseDeps,
): Promise<{ removed: number; renamed: number }> {
  const marks = FORMERLY_DEVICE_OWNED.map(() => '?').join(', ');
  const rows = (await deps.db.all(
    `SELECT a.id AS id, a.source AS source, a.identifier AS identifier,
            a.owner_device_id AS ownerDeviceId, a.created_at AS createdAt,
            (SELECT count(*) FROM documents d WHERE d.account_id = a.id) AS docs
       FROM accounts a WHERE a.source IN (${marks})`,
    [...FORMERLY_DEVICE_OWNED],
  )) as CollapseRow[];
  const plan = planCollapse(
    rows.map((r) => ({
      ...r,
      docs: Number(r.docs),
      ownerDeviceId: r.ownerDeviceId ?? null,
    })),
  );
  for (const id of plan.remove) await deps.remove(id as AccountId);
  for (const r of plan.rename)
    await deps.store.commit({
      renameAccount: { id: r.id as AccountId, identifier: r.identifier },
    });
  return { removed: plan.remove.length, renamed: plan.rename.length };
}

/** After a failed collapse: a row of a formerly device-owned source that is
 *  not yet clean must not start, or every leftover would sweep. */
export const uncleanFormerlyOwned = (a: {
  source: string;
  identifier: string;
  ownerDeviceId?: string | null;
}): boolean =>
  FORMERLY_DEVICE_OWNED.includes(a.source) &&
  !clean({
    id: '',
    source: a.source,
    identifier: a.identifier,
    ownerDeviceId: a.ownerDeviceId ?? null,
    createdAt: '',
    docs: 0,
  });
