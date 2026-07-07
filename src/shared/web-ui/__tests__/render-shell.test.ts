import { renderShell, ShellCss } from '../render-shell';

const css: ShellCss = {
  tokens: ':root{--x:1}',
  components: '.btn{}',
  shell: '.sh-hero{}',
};

describe('renderShell', () => {
  it('returns valid HTML with <!doctype>', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'hero',
      body: '<p>hi</p>',
      hero: { tagline: 'T', sub: 'S' },
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>X</title>');
    expect(html).toContain('<p>hi</p>');
  });

  it('inlines all three CSS strings in one <style>', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'app',
      body: '',
    });
    expect(html).toMatch(
      /<style>[\s\S]*--x:1[\s\S]*\.btn\{\}[\s\S]*\.sh-hero\{\}[\s\S]*<\/style>/,
    );
  });

  it('escapes title to prevent XSS', () => {
    const html = renderShell(css, {
      title: '<script>alert(1)</script>',
      variant: 'minimal',
      body: 'ok',
    });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('escapes hero.tagline and hero.sub', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'hero',
      body: '',
      hero: { tagline: '<b>t</b>', sub: '"s&s"' },
    });
    expect(html).toContain('&lt;b&gt;t&lt;/b&gt;');
    expect(html).toContain('&quot;s&amp;s&quot;');
  });

  it('escapes errorCode in the footer pill', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'minimal',
      body: 'b',
      errorCode: '<x>',
    });
    expect(html).toContain('&lt;x&gt;');
  });

  it('renders hero variant with hero panel markup', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'hero',
      body: '<p>form</p>',
      hero: { tagline: 'Hello', sub: 'World' },
    });
    expect(html).toContain('class="sh-hero"');
    expect(html).toContain('class="sh-hero__brand"');
    expect(html).toContain('Hello');
    expect(html).toContain('World');
  });

  it('renders app variant with topbar + framed Bracket brand', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'app',
      body: '<p>main</p>',
    });
    expect(html).toContain('class="sh-app"');
    expect(html).toContain('class="sh-app__topbar"');
    // The "kia" wordmark leads with the framed Bracket (reticle stroke).
    expect(html).toContain('class="sh-app__brand-mark"');
    expect(html).toContain('stroke="#a78bfa"');
  });

  it('renders minimal variant', () => {
    const html = renderShell(css, {
      title: 'Hello',
      variant: 'minimal',
      body: '<p>bye</p>',
    });
    expect(html).toContain('class="sh-min"');
    expect(html).toContain('<p>bye</p>');
  });

  it('sets meta description when given', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'minimal',
      body: '',
      meta: { description: 'A page' },
    });
    expect(html).toContain('<meta name="description" content="A page"');
  });

  it('escapes meta description', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'minimal',
      body: '',
      meta: { description: '"x"' },
    });
    expect(html).toContain('content="&quot;x&quot;"');
  });

  it('uses default wordmark "kia" when not specified', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'app',
      body: '<p>main</p>',
    });
    expect(html).toMatch(/>kia\s*<\/span>/);
  });

  it('uses custom wordmark when specified', () => {
    const html = renderShell(css, {
      title: 'X',
      variant: 'app',
      body: '<p>main</p>',
      wordmark: 'CustomApp',
    });
    expect(html).toMatch(/>CustomApp\s*<\/span>/);
  });
});
