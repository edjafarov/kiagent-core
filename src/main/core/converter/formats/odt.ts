/** OpenDocument text → markdown from content.xml (+ the meta.xml title):
 *  headings, paragraphs, lists, tables and sections, in document order. Pure. */
import { openZipParts } from './zip-parts';
import { attr, byLocalName, parseXml, textContent } from './xml';

const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

function block(el: Element): string | null {
  switch (el.localName) {
    case 'h': {
      const level = Number(attr(el, 'outline-level')) || 1;
      const t = textContent(el).trim();
      return t ? `${'#'.repeat(Math.min(level, 6))} ${t}` : null;
    }
    case 'p':
      return textContent(el).trim() || null;
    case 'list':
      return (
        byLocalName(el, 'list-item')
          .map((li) => {
            const t = [...byLocalName(li, 'p'), ...byLocalName(li, 'h')]
              .filter((p) => p.parentNode === li)
              .map((p) => textContent(p).trim())
              .filter(Boolean)
              .join(' ');
            return t ? `- ${t}` : '';
          })
          .filter(Boolean)
          .join('\n') || null
      );
    case 'table':
      return (
        byLocalName(el, 'table-row')
          .map((row) =>
            byLocalName(row, 'table-cell')
              .map((c) =>
                [...byLocalName(c, 'p'), ...byLocalName(c, 'h')]
                  .map((p) => textContent(p).trim())
                  .filter(Boolean)
                  .join(' '),
              )
              .join(' | '),
          )
          .filter((r) => r.replace(/[|\s]/g, ''))
          .join('\n') || null
      );
    case 'section':
    case 'index-body':
      return blocks(el).join('\n\n') || null;
    default:
      return null;
  }
}

function blocks(parent: Element): string[] {
  const out: string[] = [];
  for (let c = parent.firstChild; c; c = c.nextSibling)
    if (c.nodeType === 1) {
      const b = block(c as Element);
      if (b) out.push(b);
    }
  return out;
}

export async function odtToMarkdown(bytes: Uint8Array): Promise<string> {
  const parts = await openZipParts(bytes);
  const content = await parts.text('content.xml');
  if (!content) throw new Error('odt: no content.xml');
  const out: string[] = [];
  const meta = await parts.text('meta.xml');
  const title = meta ? byLocalName(parseXml(meta), 'title')[0] : undefined;
  if (title && textContent(title).trim())
    out.push(`# ${textContent(title).trim()}`);
  const text = byLocalName(parseXml(content), 'text').find(
    (e) => e.namespaceURI === OFFICE_NS,
  );
  if (text) out.push(...blocks(text));
  return out.join('\n\n');
}
