import { loadShellCss } from '../loader-node';

describe('loadShellCss (node)', () => {
  it('loads css for hero variant', () => {
    const css = loadShellCss('hero');
    expect(css.tokens.length).toBeGreaterThan(0);
    expect(css.components.length).toBeGreaterThan(0);
    expect(css.shell.length).toBeGreaterThan(0);
    // hero shell has the .sh-hero class
    expect(css.shell).toContain('.sh-hero');
  });

  it('loads css for app variant', () => {
    const css = loadShellCss('app');
    expect(css.shell).toContain('.sh-app');
  });

  it('loads css for minimal variant', () => {
    const css = loadShellCss('minimal');
    expect(css.shell).toContain('.sh-min');
  });

  it('memoizes within a process', () => {
    const a = loadShellCss('hero');
    const b = loadShellCss('hero');
    expect(a).toBe(b); // same reference
  });
});
