/** @jest-environment node */
import { createInstallLinks } from '../install-links';

function make(scheme: string | null = 'kiagent') {
  const calls: string[] = [];
  const links = createInstallLinks({
    scheme: scheme ?? undefined,
    show: () => calls.push('show'),
    nudge: () => calls.push('nudge'),
    log: (m) => calls.push(`log:${m}`),
  });
  return { links, calls };
}

describe('install links', () => {
  it('handles nothing without a product scheme', () => {
    const { links, calls } = make(null);
    links.markReady();
    links.offer('kiagent://install?repo=o/r');
    links.offerArgv(['app', 'kiagent://install?repo=o/r']);
    expect(links.take()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('drops an invalid link and logs without the URL', () => {
    const { links, calls } = make();
    links.markReady();
    links.offer('kiagent://install?repo=o/r&secret=hunter2');
    expect(links.take()).toBeNull();
    expect(calls).toEqual(['log:ignored install link']);
  });

  it('keeps one link: the latest wins, and seq increments', () => {
    const { links } = make();
    links.markReady();
    links.offer('kiagent://install?repo=a/one');
    links.offer('kiagent://install?repo=b/two&tag=v2');
    expect(links.take()).toEqual({
      seq: 2,
      owner: 'b',
      repo: 'two',
      tag: 'v2',
    });
  });

  it('take clears the slot', () => {
    const { links } = make();
    links.markReady();
    links.offer('kiagent://install?repo=o/r');
    expect(links.take()).not.toBeNull();
    expect(links.take()).toBeNull();
  });

  it('before startup made the window, it only stores; markReady then shows and nudges', () => {
    const { links, calls } = make();
    links.offer('kiagent://install?repo=o/r');
    expect(calls).toEqual([]);
    links.markReady();
    expect(calls).toEqual(['show', 'nudge']);
    expect(links.take()).toMatchObject({ owner: 'o', repo: 'r' });
  });

  it('after startup, a link shows the window and nudges', () => {
    const { links, calls } = make();
    links.markReady();
    expect(calls).toEqual([]);
    links.offer('kiagent://install?repo=o/r');
    expect(calls).toEqual(['show', 'nudge']);
  });

  it('offerArgv finds the scheme argument among the others', () => {
    const { links } = make();
    links.markReady();
    links.offerArgv([
      '/Applications/KIAgent.exe',
      '--allow-file-access',
      'KIAgent://install?repo=o/r',
    ]);
    expect(links.take()).toMatchObject({ owner: 'o', repo: 'r' });
  });
});
