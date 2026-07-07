import { describeConnectError } from '../errors';

describe('describeConnectError', () => {
  it('produces an auth-specific message when authenticationFailed is set', () => {
    const msg = describeConnectError({
      authenticationFailed: true,
      responseText: 'Invalid credentials',
      message: 'Command failed',
    });
    expect(msg).toContain('Authentication failed');
    expect(msg).toContain('Invalid credentials');
  });

  it('detects auth failures heuristically from the message when the flag is absent', () => {
    const msg = describeConnectError({ message: 'auth failure: bad password' });
    expect(msg).toContain('Authentication failed');
  });

  it('falls back to a generic connect-failed message otherwise', () => {
    const msg = describeConnectError({ message: 'ECONNREFUSED' });
    expect(msg).toContain('Could not connect');
    expect(msg).toContain('ECONNREFUSED');
  });

  it('handles a raw thrown string/non-Error value', () => {
    const msg = describeConnectError('boom');
    expect(msg).toContain('Could not connect');
    expect(msg).toContain('boom');
  });
});
