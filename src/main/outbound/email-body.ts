/**
 * The one rendering of a draft's Markdown as email (alpha-cent
 * docs/superpowers/specs/2026-10-21-outbox-formatted-mail-send-menu-design.md
 * §3.1): every sender, every preview and the provider-sync comparison use it,
 * so what the review shows is what goes out. Raw HTML in the Markdown is
 * escaped, never passed through — a stray `<!--` or `<style>` from a model can
 * neither hide the rest of the mail nor run anywhere — and links keep only
 * http(s)/mailto targets.
 */
import { createHash } from 'crypto';
import { decodeHTML } from 'entities';
import { Marked, type Tokens } from 'marked';

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const SAFE_HREF = /^(https?:|mailto:)/i;

const WRAP =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1e293b";
const HEADING: Record<number, string> = {
  1: 'font-size:20px;margin:16px 0 8px',
  2: 'font-size:17px;margin:16px 0 8px',
  3: 'font-size:15px;margin:12px 0 6px',
};

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // Raw HTML is the model's text, shown as text.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return esc(text);
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(href.trim())) return inner;
      const t = title ? ` title="${esc(title)}"` : '';
      return `<a href="${esc(href.trim())}"${t}>${inner}</a>`;
    },
    // No remote loads in a mail Kia sends: an image is a link to it.
    image({ href, text }: Tokens.Image) {
      const label = esc(text || href);
      return SAFE_HREF.test(href.trim())
        ? `<a href="${esc(href.trim())}">${label}</a>`
        : label;
    },
    heading({ tokens, depth }: Tokens.Heading) {
      const style = HEADING[depth] ?? 'font-size:14px;margin:12px 0 6px';
      return `<h${depth} style="${style}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

function fallback(markdown: string): string {
  return markdown
    .split(/\n[ \t]*\n/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export interface EmailBody {
  /** An HTML fragment, inline-styled (mail clients strip <style>). */
  html: string;
  /** The text/plain alternative: the Markdown itself. */
  text: string;
}

export function renderEmailBody(
  markdown: string,
  onError?: (e: unknown) => void,
): EmailBody {
  let inner: string;
  try {
    inner = marked.parse(markdown) as string;
  } catch (e) {
    onError?.(e);
    inner = fallback(markdown);
  }
  return { html: `<div style="${WRAP}">${inner}</div>`, text: markdown };
}

const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'tt',
  'u',
  'var',
]);

/**
 * What a reader takes from an HTML body: its words, and every link and image
 * target as a token of its own. Formatting (tags, styles, whitespace) is not
 * in it, so a provider re-serializing Kia's HTML, or the user bolding a word,
 * compares equal; any changed word, link or image does not.
 */
export function wordsOf(html: string): string {
  const text = html
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>|<[^>]*>/gi, (tag, name?: string) => {
      const m = /\b(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      if (m) return ` [${m[1].toLowerCase()}:${m[3] ?? m[4] ?? m[5] ?? ''}] `;
      // Inline formatting sits inside a word run; anything else separates.
      return name && INLINE.has(name.toLowerCase()) ? '' : ' ';
    });
  return collapse(decodeHTML(text));
}

/** All whitespace (incl. no-break spaces) as one space, trimmed. */
export function collapse(s: string): string {
  return s.replace(/[\s\u00a0\u200b]+/g, ' ').trim();
}

/** The exact provider body, for "is this still Kia's own write". */
export function bodyHash(c: { bodyHtml?: string; bodyText: string }): string {
  return createHash('sha256')
    .update(c.bodyHtml ?? '')
    .update('\0')
    .update(c.bodyText)
    .digest('hex');
}
