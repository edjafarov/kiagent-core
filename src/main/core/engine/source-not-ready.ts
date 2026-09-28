/** `WorkerSession.fetchBytes` on a document whose source has not registered
 *  YET. Transient: a worker should `defer` and let its re-drive retry. */
export class SourceNotReadyError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(`source '${source}' is not registered yet`);
    this.name = 'SourceNotReadyError';
    this.source = source;
  }
}
