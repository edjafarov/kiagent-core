/** @jest-environment node */
import { assertAccountIdentity, IdentityMismatchError } from '../source-errors';

describe('assertAccountIdentity', () => {
  it('accepts identities that differ only by case and surrounding whitespace', () => {
    expect(() =>
      assertAccountIdentity('Me@Example.com', '  me@example.com '),
    ).not.toThrow();
  });

  it('throws IdentityMismatchError naming BOTH identities', () => {
    let thrown: unknown;
    try {
      assertAccountIdentity('me@example.com', 'someone.else@example.com');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IdentityMismatchError);
    expect((thrown as Error).message).toBe(
      'this reconnect signed in as someone.else@example.com, but this ' +
        'account is me@example.com — sign in with the original account, or ' +
        'add the new one as a separate source',
    );
  });

  it('carries a stable `name`, so a stage classifier can key off it', () => {
    // flow-telemetry.ts's folderFlowStage() maps this error to the
    // 'reauth-identity' stage by instanceof, with `name` as a second arm for
    // a transport that rebuilds the object but keeps its name. (The
    // extension-rpc wire keeps neither — see the reviewer notes.)
    expect(new IdentityMismatchError('x').name).toBe('IdentityMismatchError');
  });

  it('never carries a credential: the message is built from the two identities only', () => {
    // A source calls this with the identity it read back from the provider —
    // never with the token it used to read it. Pin that the helper has no
    // other input to leak.
    expect(assertAccountIdentity.length).toBe(2);
  });
});
