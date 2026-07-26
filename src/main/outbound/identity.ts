/**
 * The ONE place an account becomes an email address. Account.identifier is
 * `${user}@${host}` (imap source connect flow) — display/uniqueness only,
 * NEVER an address. Sending identity: explicit config.outbound.fromAddress,
 * else config.user when it is itself an email (the overwhelmingly common
 * IMAP setup), else the user must configure one.
 */
import type { Account } from '@shared/contracts';

export const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface OutboundAccountConfig {
  user?: string;
  outbound?: { fromAddress?: string };
}

export function senderAddressFor(account: Account): string {
  const cfg = account.config as OutboundAccountConfig;
  const explicit = cfg.outbound?.fromAddress?.trim();
  if (explicit && EMAIL_RX.test(explicit)) return explicit;
  const user = cfg.user?.trim();
  if (user && EMAIL_RX.test(user)) return user;
  throw new Error(
    `outbound: account '${account.identifier}' has no usable From address — ` +
      `set one in the account's Outbound settings.`,
  );
}

export function selfAddressesFor(account: Account): string[] {
  const sender = senderAddressFor(account);
  const user = (account.config as OutboundAccountConfig).user?.trim();
  const out = [sender];
  if (
    user &&
    EMAIL_RX.test(user) &&
    user.toLowerCase() !== sender.toLowerCase()
  )
    out.push(user);
  return out;
}
