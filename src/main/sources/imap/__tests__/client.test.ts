import { EventEmitter } from 'node:events';
import { attachImapErrorHandler, toImapFlowOptions } from '../client';
import type { ImapAccountConfig } from '../types';

describe('toImapFlowOptions', () => {
  it('maps our config + password to imapflow options', () => {
    const config: ImapAccountConfig = { host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com' };
    const opts = toImapFlowOptions(config, 'hunter2');
    expect(opts).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'me@example.com', pass: 'hunter2' },
      logger: false,
    });
  });

  it('preserves secure:false (STARTTLS) verbatim', () => {
    const config: ImapAccountConfig = { host: 'h', port: 143, secure: false, user: 'u' };
    expect(toImapFlowOptions(config, 'p').secure).toBe(false);
  });
});

describe('attachImapErrorHandler', () => {
  it('attaches a listener so an emitted error does not throw', () => {
    const flow = new EventEmitter();
    const log = jest.fn();
    attachImapErrorHandler(flow, log);
    expect(() => flow.emit('error', new Error('socket timeout'))).not.toThrow();
    expect(log).toHaveBeenCalledWith('[imap] client error', '', 'socket timeout');
  });

  it('reads a structured error code when present', () => {
    const flow = new EventEmitter();
    const log = jest.fn();
    attachImapErrorHandler(flow, log);
    flow.emit('error', { code: 'ECONNRESET', message: 'reset' });
    expect(log).toHaveBeenCalledWith('[imap] client error', 'ECONNRESET', 'reset');
  });
});
