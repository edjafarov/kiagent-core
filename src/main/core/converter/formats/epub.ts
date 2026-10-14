/** EPUB → markdown: OPF metadata, then the spine's XHTML in reading order
 *  through the shared HTML→markdown converter. Stops reading chapters once
 *  the markdown cap is reached. Pure. */
import { MAX_MARKDOWN_CHARS } from './limits';
import { openZipParts } from './zip-parts';
import { byLocalName, parseXml, textContent } from './xml';

const join = (dir: string, href: string): string => {
  let path = href.split('#')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // a literal % in a file name: use the href as written
  }
  const out: string[] = [];
  for (const s of `${dir}/${path}`.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return out.join('/');
};

export async function epubToMarkdown(
  bytes: Uint8Array,
  html: (s: string) => Promise<string>,
): Promise<string> {
  const parts = await openZipParts(bytes);
  const container = await parts.text('META-INF/container.xml');
  if (!container) throw new Error('epub: no META-INF/container.xml');
  const rootfile = byLocalName(parseXml(container), 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path') ?? '';
  const opf = opfPath ? await parts.text(opfPath) : null;
  if (!opf) throw new Error('epub: no package document');
  const doc = parseXml(opf);
  const dir = opfPath.includes('/')
    ? opfPath.slice(0, opfPath.lastIndexOf('/'))
    : '';
  const meta = (n: string) => {
    const e = byLocalName(doc, n)[0];
    return e ? textContent(e).trim() : '';
  };
  const out: string[] = [];
  if (meta('title')) out.push(`# ${meta('title')}`);
  if (meta('creator')) out.push(`**Author:** ${meta('creator')}`);
  const hrefs = new Map(
    byLocalName(doc, 'item').map((i) => [
      i.getAttribute('id') ?? '',
      i.getAttribute('href') ?? '',
    ]),
  );
  let size = 0;
  for (const ref of byLocalName(doc, 'itemref')) {
    const href = hrefs.get(ref.getAttribute('idref') ?? '');
    if (!href) continue;
    const xhtml = await parts.text(join(dir, href));
    if (!xhtml) continue;
    const md = (await html(xhtml)).trim();
    if (!md) continue;
    out.push(md);
    size += md.length;
    if (size > MAX_MARKDOWN_CHARS) break;
  }
  return out.join('\n\n');
}
