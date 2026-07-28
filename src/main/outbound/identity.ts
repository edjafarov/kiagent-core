/**
 * The ONE place an account becomes an email address. Account.identifier is
 * `${user}@${host}` (imap source connect flow) — display/uniqueness only,
 * NEVER an address. Sending identity: explicit config.outbound.fromAddress,
 * else config.user when it is itself an email (the overwhelmingly common
 * IMAP setup), else the user must configure one.
 *
 * gmail is the one source where Account.identifier IS the mailbox address
 * (stamped from users.getProfile at connect time) — it short-circuits both
 * functions below BEFORE the fromAddress logic, and config.outbound.fromAddress
 * is deliberately ignored: Gmail rejects a From header that isn't one of the
 * account's own verified aliases, so honoring an arbitrary override would
 * just produce a bounce.
 */
import type { Account } from '@shared/contracts';

export const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface OutboundAccountConfig {
  user?: string;
  outbound?: { fromAddress?: string };
}

export function senderAddressFor(account: Account): string {
  // Compose is email-only. A source that sends through an extension Sender
  // (slack, …) can still REPLY — its target is the opaque
  // `metadata.outbound.ref` the source itself wrote, never an address — but
  // it has no From address to originate a new message from, and no account
  // configuration could ever produce one. Say that, rather than falling
  // through to the config-shaped advice below, which would send the user
  // hunting for an Outbound setting that cannot help.
  // Safe for the bundled senders that call this (smtp.ts, gmail.ts): each
  // only ever runs for its own source.
  if (account.source !== 'imap' && account.source !== 'gmail') {
    throw new Error(
      `compose is email-only — '${account.source}' accounts are reply-only`,
    );
  }
  if (account.source === 'gmail') return account.identifier;
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
  if (account.source === 'gmail') return [account.identifier];
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
