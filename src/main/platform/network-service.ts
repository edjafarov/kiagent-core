import {
  createNetFetch,
  type NetFetchInit,
  type NetFetchResult,
} from './net-guard';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export interface NetworkDiagnostic {
  owner: string;
  operation: 'fetch';
  durationMs: number;
  status?: number;
  bytes?: number;
}

export interface NetworkServiceOptions {
  owner: string;
  log: (event: NetworkDiagnostic) => void;
  signal?: AbortSignal;
  fetch?: (url: string, init?: NetFetchInit) => Promise<NetFetchResult>;
}

export interface NetworkService {
  fetch(
    url: string,
    init?: NetFetchInit & { timeoutMs?: number },
  ): Promise<NetFetchResult>;
  dispose(): void;
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  Object.assign(error, { code: 'RPC_ABORTED' });
  return error;
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`Network request timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  return error;
}

function timeoutValue(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be finite and between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function raceDependency<T>(
  work: Promise<T>,
  signal: AbortSignal,
  onLate: (value: T) => void,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (!settled) {
        settled = true;
        reject(abortError());
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (settled) onLate(value);
        else {
          settled = true;
          resolve(value);
        }
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
  });
}

function combinedSignal(
  ownerSignal: AbortSignal,
  callSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const signals = [ownerSignal, callSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const abort = () => controller.abort();
  if (signals.some((signal) => signal.aborted)) controller.abort();
  for (const signal of signals)
    signal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    },
  };
}

export function createNetworkService(
  options: NetworkServiceOptions,
): NetworkService {
  const ownerController = new AbortController();
  const owner = combinedSignal(ownerController.signal, options.signal);
  const ownerSignal = owner.signal;
  const fetchImpl = options.fetch ?? createNetFetch();
  let disposed = false;

  return {
    async fetch(url, init = {}) {
      if (disposed || ownerSignal.aborted) throw abortError();
      const timeoutMs = timeoutValue(init.timeoutMs);
      const started = Date.now();
      const deadline = new AbortController();
      const combined = combinedSignal(ownerSignal, init.signal);
      const onCombinedAbort = () => deadline.abort();
      combined.signal.addEventListener('abort', onCombinedAbort, {
        once: true,
      });
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      if (combined.signal.aborted) deadline.abort();
      const requestInit: NetFetchInit = {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: deadline.signal,
      };
      try {
        if (deadline.signal.aborted) throw abortError();
        const result = await raceDependency(
          fetchImpl(url, requestInit),
          deadline.signal,
          () => {},
        );
        options.log({
          owner: options.owner,
          operation: 'fetch',
          durationMs: Date.now() - started,
          status: result.status,
          bytes: result.body.byteLength,
        });
        return result;
      } catch (error) {
        options.log({
          owner: options.owner,
          operation: 'fetch',
          durationMs: Date.now() - started,
        });
        if (deadline.signal.aborted) {
          if (combined.signal.aborted) throw abortError();
          throw timeoutError(timeoutMs);
        }
        throw error;
      } finally {
        clearTimeout(timer);
        combined.signal.removeEventListener('abort', onCombinedAbort);
        combined.dispose();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ownerController.abort();
      owner.dispose();
    },
  };
}
