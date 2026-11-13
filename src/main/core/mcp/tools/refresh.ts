/**
 * `refresh` — sync a source now, on request, so "check my email" is not
 * answered from an index one cadence old. It triggers each matching
 * account's scheduler job (start-if-idle, never a restart), waits up to
 * WAIT_MS for the runs to stop, and reports what each account did.
 *
 * The tool is `foreground: false`: the foreground slot pauses background
 * ingest, which is the very work this tool waits for.
 */

export const refreshDescription = `Sync a source now, then return. \`source\` is a source id (e.g. 'gmail', 'slack'); omit it to refresh every account. Waits up to 15 s and reports per account: synced, still_running, already_running, failed (with the reason) or skipped (with the reason — paused, needs reconnect, synced on another device, refreshed less than a minute ago). Call it before \`search\` when the user asks what is new right now; not for historical questions.`;

export const refreshInputSchema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      description: "A source id, e.g. 'gmail'. Omit to refresh every account.",
    },
  },
} as const;

export interface McpSyncApi {
  accounts(): Promise<
    Array<{
      id: string;
      source: string;
      identifier: string;
      status: string;
      lastSyncAt: string | null;
      lastError: string | null;
    }>
  >;
  /** The engine gate's rule: `!ownedByOther(id) && (!readOnly() || ownsAccount(id))`. */
  runsHere(accountId: string): boolean;
  /** The device name to show for an account that does not run here. */
  syncedOn(accountId: string): string;
  /** Does the scheduler have this job (`source:<source>:<id>`)? */
  hasJob(jobId: string): boolean;
  /** Awaits `scheduler.trigger(jobId)`: returns once the job has run. */
  trigger(jobId: string): Promise<void>;
  isRunning(accountId: string): boolean;
}

export const WAIT_MS = 15_000;
export const POLL_MS = 500;
export const COOLDOWN_MS = 60_000;

export type RefreshStatus =
  | 'synced'
  | 'failed'
  | 'still_running'
  | 'already_running'
  | 'skipped';

export interface RefreshAccount {
  account: string;
  source: string;
  status: RefreshStatus;
  reason?: string;
  last_sync_at: string | null;
}

export interface RefreshClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** accountId -> when a refresh was last started; process-wide by default. */
  started: Map<string, number>;
}

const processStarted = new Map<string, number>();
const realClock: RefreshClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  started: processStarted,
};

export function makeRefreshTool(
  sync: McpSyncApi,
  clock: RefreshClock = realClock,
) {
  return async function refresh(
    args: Record<string, unknown>,
  ): Promise<{ accounts: RefreshAccount[] }> {
    const source =
      typeof args.source === 'string' && args.source ? args.source : undefined;
    // Worker accounts are synthetic (deep-extraction / enrichment): not a
    // source to refresh.
    const all = (await sync.accounts()).filter((a) => a.source !== 'worker');
    const targets = source ? all.filter((a) => a.source === source) : all;

    const out = new Map<string, RefreshAccount>();
    const triggered = new Map<string, number>(); // account id -> trigger time
    const row = (
      a: (typeof targets)[number],
      status: RefreshStatus,
      reason?: string,
    ): RefreshAccount => ({
      account: a.identifier,
      source: a.source,
      status,
      ...(reason !== undefined ? { reason } : {}),
      last_sync_at: a.lastSyncAt,
    });
    const skip = (a: (typeof targets)[number], reason: string): void => {
      out.set(a.id, row(a, 'skipped', reason));
    };

    for (const a of targets) {
      const jobId = `source:${a.source}:${a.id}`;
      if (a.status === 'paused') skip(a, 'paused');
      else if (a.status === 'needsReauth') skip(a, 'needs reconnect');
      else if (a.status === 'needs-connector') skip(a, 'needs its connector');
      else if (!sync.runsHere(a.id)) skip(a, `synced on ${sync.syncedOn(a.id)}`);
      else if (!sync.hasJob(jobId)) skip(a, 'no sync job');
      else if (clock.now() - (clock.started.get(a.id) ?? -Infinity) < COOLDOWN_MS)
        skip(a, 'fresh');
      else if (sync.isRunning(a.id)) out.set(a.id, row(a, 'already_running'));
      else {
        const at = clock.now();
        // Marked before the await so a concurrent call sees the cooldown.
        clock.started.set(a.id, at);
        try {
          await sync.trigger(jobId);
          triggered.set(a.id, at);
        } catch (err) {
          clock.started.delete(a.id);
          out.set(
            a.id,
            row(a, 'failed', err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }

    if (triggered.size > 0) {
      const deadline = clock.now() + WAIT_MS;
      const anyRunning = (): boolean =>
        [...triggered.keys()].some((id) => sync.isRunning(id));
      while (anyRunning() && clock.now() < deadline)
        await clock.sleep(POLL_MS);

      const fresh = new Map((await sync.accounts()).map((a) => [a.id, a]));
      for (const [id, at] of triggered) {
        const a = fresh.get(id) ?? targets.find((t) => t.id === id)!;
        if (sync.isRunning(id)) out.set(id, row(a, 'still_running'));
        else if (a.status === 'error' || a.status === 'needsReauth')
          out.set(
            id,
            row(a, 'failed', a.lastError ?? `account is in status '${a.status}'`),
          );
        else if (a.lastSyncAt && Date.parse(a.lastSyncAt) > at)
          out.set(id, row(a, 'synced'));
        else out.set(id, row(a, 'skipped', 'could not start'));
      }
    }

    return { accounts: targets.map((a) => out.get(a.id)!) };
  };
}
