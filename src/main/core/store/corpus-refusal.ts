/**
 * The one boot failure the app can recover from by itself (alpha-cent#93):
 * `migrate()` refusing a corpus written by a newer build. The error crosses
 * the DB worker boundary as message text only (worker-client re-wraps it as
 * `db worker failed to open: …`), so the message IS the contract — built and
 * matched here, in one place.
 */
export function corpusTooNewMessage(
  version: number,
  supported: number,
): string {
  return (
    `corpus schema v${version} is newer than this build supports ` +
    `(v${supported}). Update the app to the latest version to open ` +
    `this database, or erase and re-sync it.`
  );
}

const REFUSAL = /corpus schema v\d+ is newer than this build supports/;

export function isCorpusRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return REFUSAL.test(message);
}
