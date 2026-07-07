/**
 * Turn whatever connect()/login() threw into a clear, user-facing message.
 * imapflow reports the useful reason in structured fields, not in `.message`
 * (which is often just "Command failed"): `authenticationFailed` and the
 * server's own `responseText`. Ported from
 * kiagent-ref/src/main/connectors/imap/add-account.ts.
 */
export function describeConnectError(e: unknown): string {
  const err = e as {
    message?: string;
    authenticationFailed?: boolean;
    responseText?: string;
  };
  const serverReason = err.responseText?.trim();
  const raw = serverReason || err.message || String(e);
  const isAuth = err.authenticationFailed === true || /auth/i.test(raw);
  if (isAuth) {
    const detail = serverReason ? ` (server said: ${serverReason})` : '';
    return (
      `Authentication failed${detail}. If your provider requires an app-password ` +
      `(Gmail, iCloud, Yahoo…), use that instead of your normal password. A ` +
      `"temporary" failure can also mean too many recent attempts — wait a few ` +
      `minutes and retry.`
    );
  }
  return `Could not connect: ${raw}`;
}
