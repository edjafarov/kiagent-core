import { isAutomatedMessage } from '../filter';

describe('isAutomatedMessage', () => {
  it('passes a normal person-to-person message', () => {
    const r = isAutomatedMessage({ from: 'Alice <alice@example.com>' }, 'Alice <alice@example.com>');
    expect(r.matched).toBe(false);
  });

  it('flags Auto-Submitted != no', () => {
    const r = isAutomatedMessage({ 'auto-submitted': 'auto-replied' }, 'a@example.com');
    expect(r.matched).toBe(true);
  });

  it('does not flag Auto-Submitted: no', () => {
    const r = isAutomatedMessage({ 'auto-submitted': 'no' }, 'a@example.com');
    expect(r.matched).toBe(false);
  });

  it('flags bulk/list precedence', () => {
    expect(isAutomatedMessage({ precedence: 'bulk' }, 'a@example.com').matched).toBe(true);
    expect(isAutomatedMessage({ precedence: 'list' }, 'a@example.com').matched).toBe(true);
  });

  it('flags list headers', () => {
    expect(isAutomatedMessage({ 'list-unsubscribe': '<mailto:x>' }, 'a@example.com').matched).toBe(true);
  });

  it('flags system-sender local parts', () => {
    expect(isAutomatedMessage({}, 'no-reply@example.com').matched).toBe(true);
    expect(isAutomatedMessage({}, 'mailer-daemon@example.com').matched).toBe(true);
    expect(isAutomatedMessage({}, 'Support <bounce+123@example.com>').matched).toBe(true);
  });

  it('flags empty Return-Path (bounce)', () => {
    expect(isAutomatedMessage({ 'return-path': '<>' }, 'a@example.com').matched).toBe(true);
  });

  it('flags DSN multipart/report', () => {
    const r = isAutomatedMessage(
      { 'content-type': 'multipart/report; report-type=delivery-status' },
      'mailer@example.com',
    );
    expect(r.matched).toBe(true);
  });

  it('is header-key case-insensitive', () => {
    const r = isAutomatedMessage({ 'Precedence': 'bulk' }, 'a@example.com');
    expect(r.matched).toBe(true);
  });
});
