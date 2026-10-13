/** PowerPoint OOXML → markdown: slides in presentation order, each with its
 *  title placeholder as a heading, the remaining text (tables included), then
 *  speaker notes. Only presentation, slide, notes, rels and core-property
 *  parts are inflated. Pure. */
import { openZipParts, type ZipParts } from './zip-parts';
import { byLocalName, childByLocalName, parseXml, textContent } from './xml';

const TITLE_TYPES = new Set(['title', 'ctrTitle']);
const NOTES_SKIP = new Set(['sldNum', 'sldImg', 'hdr', 'ftr', 'dt']);
const DRAWINGML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RELS_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const phType = (sp: Element): string | null => {
  const nv = childByLocalName(sp, 'nvSpPr');
  const nvPr = nv && childByLocalName(nv, 'nvPr');
  const ph = nvPr && childByLocalName(nvPr, 'ph');
  return ph ? ph.getAttribute('type') || 'body' : null;
};

const paragraphs = (el: Element): string[] =>
  byLocalName(el, 'p')
    .filter((p) => p.namespaceURI === DRAWINGML)
    .map((p) => textContent(p).trim())
    .filter(Boolean);

const resolve = (dir: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1);
  const out: string[] = [];
  for (const s of `${dir}/${target}`.split('/')) {
    if (s === '..') out.pop();
    else if (s && s !== '.') out.push(s);
  }
  return out.join('/');
};

/** Relationship Id → { type, resolved part path } for the part at `base`. */
async function rels(
  parts: ZipParts,
  base: string,
): Promise<Map<string, { type: string; target: string }>> {
  const cut = base.lastIndexOf('/');
  const dir = base.slice(0, cut);
  const xml = await parts.text(`${dir}/_rels/${base.slice(cut + 1)}.rels`);
  const out = new Map<string, { type: string; target: string }>();
  if (!xml) return out;
  for (const r of byLocalName(parseXml(xml), 'Relationship')) {
    if (r.getAttribute('TargetMode') === 'External') continue;
    out.set(r.getAttribute('Id') ?? '', {
      type: r.getAttribute('Type') ?? '',
      target: resolve(dir, r.getAttribute('Target') ?? ''),
    });
  }
  return out;
}

export async function pptxToMarkdown(bytes: Uint8Array): Promise<string> {
  const parts = await openZipParts(bytes);
  const pres = await parts.text('ppt/presentation.xml');
  if (!pres) throw new Error('pptx: no ppt/presentation.xml');
  const presRels = await rels(parts, 'ppt/presentation.xml');
  const out: string[] = [];

  const core = await parts.text('docProps/core.xml');
  if (core) {
    const doc = parseXml(core);
    const title = byLocalName(doc, 'title')[0];
    const author = byLocalName(doc, 'creator')[0];
    if (title && textContent(title).trim())
      out.push(`# ${textContent(title).trim()}`);
    if (author && textContent(author).trim())
      out.push(`**Author:** ${textContent(author).trim()}`);
  }

  const ids = byLocalName(parseXml(pres), 'sldId');
  for (let i = 0; i < ids.length; i++) {
    const rid = ids[i].getAttributeNS(RELS_NS, 'id') ?? '';
    const part = presRels.get(rid)?.target;
    const xml = part ? await parts.text(part) : null;
    if (!part || !xml) continue;
    const slide = parseXml(xml);
    const shapes = byLocalName(slide, 'sp');
    const titleSp = shapes.find((s) => TITLE_TYPES.has(phType(s) ?? ''));
    const title = titleSp ? paragraphs(titleSp).join(' ') : '';
    const body = shapes.filter((s) => s !== titleSp).flatMap(paragraphs);
    // Tables live in graphicFrames, not shapes: take their rows too.
    for (const tr of byLocalName(slide, 'tr')) {
      const row = byLocalName(tr, 'tc')
        .map((tc) => paragraphs(tc).join(' '))
        .join(' | ');
      if (row.replace(/[|\s]/g, '')) body.push(row);
    }
    out.push(title ? `## Slide ${i + 1} — ${title}` : `## Slide ${i + 1}`);
    if (body.length) out.push(body.join('\n'));

    const notesRel = [...(await rels(parts, part)).values()].find((r) =>
      r.type.endsWith('/notesSlide'),
    );
    const notesXml = notesRel ? await parts.text(notesRel.target) : null;
    if (notesXml) {
      const notes = byLocalName(parseXml(notesXml), 'sp')
        .filter((s) => !NOTES_SKIP.has(phType(s) ?? ''))
        .flatMap(paragraphs);
      if (notes.length) out.push('### Notes', notes.join('\n'));
    }
  }
  return out.join('\n\n');
}
