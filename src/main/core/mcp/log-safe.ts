/** A tool error whose message carries user content (a draft's text, shown so
 *  the model can go on from it) keeps a content-free line for the logs and
 *  the activity feed. */
export function withLogMessage(err: Error, logMessage: string): Error {
  return Object.assign(err, { logMessage });
}

/** The line to log for a tool error: its content-free `logMessage` when it
 *  has one, else its message. */
export function logMessageOf(err: unknown): string {
  const safe = (err as { logMessage?: unknown } | null)?.logMessage;
  if (typeof safe === 'string') return safe;
  return err instanceof Error ? err.message : String(err);
}
