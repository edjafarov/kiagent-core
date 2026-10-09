import type { ExtensionSnapshot } from '@shared/contracts';

import { createBootTimer } from '../boot-timing';

const snap = (id: string, status: ExtensionSnapshot['status']) =>
  ({ id, status }) as ExtensionSnapshot;

describe('createBootTimer', () => {
  it('writes [boot] lines with ms since process start and an optional detail', () => {
    const lines: string[] = [];
    let t = 1234.4;
    const timer = createBootTimer(
      (l) => lines.push(l),
      () => t,
    );
    timer.mark('bootCore');
    t = 2000;
    timer.mark('in-process extensions active', 'kiagent.remote-mcp 120ms');
    expect(lines).toEqual([
      '[boot] bootCore +1234ms',
      '[boot] in-process extensions active +2000ms (kiagent.remote-mcp 120ms)',
    ]);
  });

  it('logs each extension activation once; all settled waits for statuses, then observation stops', () => {
    const lines: string[] = [];
    const timer = createBootTimer(
      (l) => lines.push(l),
      () => 10,
    );
    timer.observe([snap('a', 'activating')]);
    timer.observe([snap('a', 'activated')]);
    timer.observe([snap('a', 'activated')]);
    timer.armSettled([snap('a', 'activated')]);
    timer.observe([snap('b', 'activated')]);
    timer.mark('window shown'); // marks still write
    expect(lines).toEqual([
      '[boot] extension a activated +10ms',
      '[boot] all settled +10ms',
      '[boot] window shown +10ms',
    ]);
  });

  it('handshake timeout → retry → activated: the late activation is logged, then all settled', () => {
    const lines: string[] = [];
    const timer = createBootTimer(
      (l) => lines.push(l),
      () => 10,
    );
    // startUtility() returned with kia.slow's retry merely scheduled:
    timer.armSettled([
      snap('kia.fast', 'activated'),
      snap('kia.slow', 'activating'),
    ]);
    timer.observe([
      snap('kia.fast', 'activated'),
      snap('kia.slow', 'activating'),
    ]); // retry
    expect(lines).toEqual(['[boot] extension kia.fast activated +10ms']);
    timer.observe([
      snap('kia.fast', 'activated'),
      snap('kia.slow', 'activated'),
    ]);
    expect(lines).toEqual([
      '[boot] extension kia.fast activated +10ms',
      '[boot] extension kia.slow activated +10ms',
      '[boot] all settled +10ms',
    ]);
  });

  it('errored and needs-consent entries count as settled', () => {
    const lines: string[] = [];
    const timer = createBootTimer(
      (l) => lines.push(l),
      () => 10,
    );
    timer.armSettled([snap('x', 'errored'), snap('y', 'needs-consent')]);
    expect(lines).toEqual(['[boot] all settled +10ms']);
  });
});
