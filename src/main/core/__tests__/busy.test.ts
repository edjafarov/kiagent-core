/** @jest-environment node */
import { createBusyRegistry } from '../busy';

describe('busy registry', () => {
  it('is not busy until an owner sets a reason, and clears per owner', () => {
    const b = createBusyRegistry();
    expect(b.get()).toEqual({ busy: false, reasons: [] });
    b.set('ext.a', 'recording');
    b.set('ext.b', 'presenting');
    expect(b.get()).toEqual({
      busy: true,
      reasons: ['recording', 'presenting'],
    });
    b.set('ext.a', null);
    expect(b.get()).toEqual({ busy: true, reasons: ['presenting'] });
    b.set('ext.b', null);
    expect(b.get().busy).toBe(false);
  });

  it('an owner setting again replaces its own reason', () => {
    const b = createBusyRegistry();
    b.set('ext.a', 'one');
    b.set('ext.a', 'two');
    expect(b.get().reasons).toEqual(['two']);
  });
});
