/**
 * #140 window-first boot: the tail of main.ts's whenReady, extracted so its
 * ORDER is unit-testable without Electron. Everything above it (bootCore,
 * mcp, registerIpc, engine.project) is unchanged.
 *
 * - Interrupted reset journaled: today's fully sequential path (reset dialog
 *   → reset → all extensions → resume → scheduler → window). Rare; keeps
 *   "nothing syncs before the reset finishes" trivially true.
 * - Otherwise: discovery → arm the boot queue → in-process extensions
 *   (bounded at IN_PROCESS_READY_MS) → window → background chain
 *   (resume ready accounts → scheduler → utility extensions).
 *
 * Extension discovery/start failures are inert (logged, window still
 * opens); nothing here may reach handleBootFailure for them.
 */
import type { FactoryResetOutcome } from '@shared/ipc';

import type { InProcessStartReport } from './platform/extension-platform';

export interface BootTailDeps {
  journalPending(): boolean;
  finishInterruptedReset(): Promise<FactoryResetOutcome | null>;
  loadExtensions(): Promise<void>;
  /** BootQueue.arm(extensions.snapshot()) — after discovery, before any
   *  in-process source can register. */
  armQueue(): void;
  startInProcess(): Promise<InProcessStartReport>;
  /** Journal path only: every enabled extension, awaited. */
  startAllExtensions(): Promise<void>;
  /** Journal path only: today's resumeAccounts. */
  resumeAll(): Promise<void>;
  startScheduler(): void;
  /** app.on('activate', showMainWindow) — registered before the window. */
  registerActivate(): void;
  createWindow(): Promise<void>;
  /** startBackground(...) — fired, never awaited. */
  startBackground(): Promise<void>;
  mark(step: string, detail?: string): void;
  /** 'extension platform failed to start' — the old inert() log line. */
  logError(error: unknown): void;
}

export function formatInProcess(report: InProcessStartReport): string {
  const done = Object.entries(report.activatedMs)
    .map(([id, ms]) => `${id} ${ms}ms`)
    .join(', ');
  return report.pending.length > 0
    ? `${done}; pending: ${report.pending.join(', ')}`
    : done;
}

export async function bootTail(
  d: BootTailDeps,
): Promise<FactoryResetOutcome | null> {
  // A broken extensions dir (e.g. `extensions` exists as a plain file, so
  // mkdirSync throws) must be fully inert — never abort boot, or no window
  // ever opens.
  const inert = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      d.logError(error);
    }
  };

  if (d.journalPending()) {
    const outcome = await d.finishInterruptedReset();
    await inert(() => d.startAllExtensions());
    await d.resumeAll();
    d.startScheduler();
    d.registerActivate();
    await d.createWindow();
    return outcome;
  }

  await inert(() => d.loadExtensions());
  d.mark('extensions loaded');
  d.armQueue();
  const report = await d.startInProcess().catch((error: unknown) => {
    d.logError(error);
    return null;
  });
  d.mark(
    'in-process extensions active',
    report ? formatInProcess(report) : undefined,
  );
  d.registerActivate();
  d.mark('createWindow start');
  await d.createWindow();
  d.mark('window loaded');
  void d.startBackground().catch((error: unknown) => d.logError(error));
  return null;
}
