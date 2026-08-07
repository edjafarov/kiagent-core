/**
 * Main-process crash and boot-failure visibility.
 *
 * In a packaged build `console.error` goes nowhere. A boot failure therefore
 * presented as "no window opened and the log explains nothing", and an uncaught
 * exception took the process down without leaving a trace — the one excellent
 * log sink this codebase has never saw those paths, because they happen either
 * before it exists or on the way out.
 *
 * Two details make this work where a naive `sink.log()` call would not:
 *
 *  - The record is appended **synchronously** to the same JSONL the sink writes.
 *    The sink's own append is `fs.appendFile` with a swallowed callback, which
 *    does not flush before `process.exit` — precisely the case that matters
 *    here. The sink is still notified afterwards so the live viewer and the
 *    in-memory ring see it too, but the file write is the one that has to land.
 *  - The sink is resolved through a callback rather than captured, because at
 *    boot-failure time there isn't one yet.
 *
 * Fatality is left exactly as Electron already has it, verified against this
 * build rather than assumed — the two are not the same:
 *
 *  - An uncaught exception is fatal. Electron's own default puts up a native
 *    error dialog and ends the process; this keeps that, and adds a record plus
 *    a message naming the file to look in.
 *  - An unhandled rejection is *not* fatal here — Electron warns and carries on.
 *    So it is recorded and nothing else. Exiting would have turned every stray
 *    rejection in a long-running indexer into a fatal modal, which is a much
 *    worse app than the one this issue set out to make diagnosable.
 *
 * Electron is injected rather than imported so the policy is testable without
 * booting a browser process.
 */
import fs from 'fs';
import path from 'path';

import type { LogLevel } from '@shared/contracts';

export const CRASH_LOG_FILE = 'kiagent.log.jsonl';

export interface CrashSink {
  log(
    scope: string,
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
}

export interface CrashDeps {
  /** The directory `createLogs()` writes to — `<dataDir>/logs`. */
  logDir: string;
  /** Null until `bootCore` has produced one, which is exactly when boot
   *  failures happen. */
  sink: () => CrashSink | null;
  showErrorBox: (title: string, content: string) => void;
  exit: (code: number) => void;
  /** `app.on` for the two process-gone events, injected for testability. */
  onAppEvent?: (
    event: 'render-process-gone' | 'child-process-gone',
    handler: (...args: unknown[]) => void,
  ) => void;
}

/** Pulls a loggable shape out of anything that can be thrown. */
export function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause === undefined ? {} : { cause: String(err.cause) }),
    };
  }
  return { message: String(err) };
}

/**
 * Writes one crash record durably, then tells the sink. Never throws — a
 * failure to log must not become the thing that takes the process down.
 */
export function recordCrash(
  deps: CrashDeps,
  scope: string,
  msg: string,
  err: unknown,
): void {
  const fields = describeError(err);
  const record = {
    ts: new Date().toISOString(),
    level: 'error' as const,
    scope,
    msg,
    fields,
  };
  try {
    fs.mkdirSync(deps.logDir, { recursive: true });
    fs.appendFileSync(
      path.join(deps.logDir, CRASH_LOG_FILE),
      `${JSON.stringify(record)}\n`,
    );
  } catch {
    // Disk full, permissions, a read-only volume — nothing useful left to do.
  }
  try {
    deps.sink()?.log(scope, 'error', msg, fields);
  } catch {
    // A sink that throws must not suppress the record already on disk.
  }
}

function logFilePath(deps: CrashDeps): string {
  return path.join(deps.logDir, CRASH_LOG_FILE);
}

/**
 * Reports a failure during startup: nothing has a window yet, so without a
 * dialog the app simply never appears.
 */
export function reportBootFailure(deps: CrashDeps, err: unknown): void {
  recordCrash(deps, 'main.boot', 'boot failed', err);
  const { message } = describeError(err);
  deps.showErrorBox(
    'kiagent could not start',
    `${String(message)}\n\nDetails were written to:\n${logFilePath(deps)}`,
  );
  deps.exit(1);
}

/**
 * Installs the process- and app-level handlers. Returns a function that removes
 * the process listeners again, so tests (and any future re-init) don't stack
 * them up.
 */
export function installCrashHandlers(deps: CrashDeps): () => void {
  // Fatal, matching Electron's own default — but now with a record on disk and
  // a message that says where to look.
  const onUncaught = (err: unknown) => {
    recordCrash(deps, 'main.crash', 'uncaught exception', err);
    const { message } = describeError(err);
    deps.showErrorBox(
      'kiagent has stopped',
      `${String(message)}\n\nDetails were written to:\n${logFilePath(deps)}`,
    );
    deps.exit(1);
  };

  // Not fatal in this Electron, and deliberately not made fatal here: a stray
  // rejection during shutdown or a source abort must not take the app down.
  const onRejection = (err: unknown) => {
    recordCrash(deps, 'main.crash', 'unhandled rejection', err);
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  // A dead renderer or utility child does not end the main process, so these
  // are recorded and left alone — the supervisors above them decide what to do.
  deps.onAppEvent?.('render-process-gone', (...args) => {
    recordCrash(deps, 'main.crash', 'render process gone', args[2] ?? args[1]);
  });
  deps.onAppEvent?.('child-process-gone', (...args) => {
    recordCrash(deps, 'main.crash', 'child process gone', args[1]);
  });

  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}
