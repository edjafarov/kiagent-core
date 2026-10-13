import JSZip from 'jszip';

const XML = '<?xml version="1.0" encoding="UTF-8"?>';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface SlideSpec {
  title?: string;
  body?: string[];
  notes?: string[];
}

const sp = (paras: string[], ph?: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/><p:nvPr>${
    ph ? `<p:ph type="${ph}"/>` : ''
  }</p:nvPr></p:nvSpPr><p:txBody>${paras
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;

export async function pptxBytes(
  slides: SlideSpec[],
  opts: { title?: string; author?: string; dropSlide?: number } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    `${XML}<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${slides
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
      .join('')}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `${XML}<Relationships xmlns="${REL}">${slides
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`,
      )
      .join('')}</Relationships>`,
  );
  slides.forEach((s, i) => {
    const n = i + 1;
    if (opts.dropSlide === n) return;
    zip.file(
      `ppt/slides/slide${n}.xml`,
      `${XML}<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${
        s.title ? sp([s.title], 'title') : ''
      }${s.body ? sp(s.body) : ''}</p:spTree></p:cSld></p:sld>`,
    );
    if (s.notes) {
      zip.file(
        `ppt/slides/_rels/slide${n}.xml.rels`,
        `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId9" Type="${R}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`,
      );
      zip.file(
        `ppt/notesSlides/notesSlide${n}.xml`,
        `${XML}<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>${sp(
          [String(n)],
          'sldNum',
        )}${sp(s.notes, 'body')}</p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  if (opts.title || opts.author)
    zip.file(
      'docProps/core.xml',
      `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${
        opts.title ? `<dc:title>${opts.title}</dc:title>` : ''
      }${opts.author ? `<dc:creator>${opts.author}</dc:creator>` : ''}</cp:coreProperties>`,
    );
  return zip.generateAsync({ type: 'uint8array' });
}

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';

/** `body` is raw ODF XML placed inside office:text. */
export async function odtBytes(
  body: string,
  title?: string,
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file(
    'content.xml',
    `${XML}<office:document-content ${ODF_NS}><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  );
  if (title)
    zip.file(
      'meta.xml',
      `${XML}<office:document-meta ${ODF_NS} xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>${title}</dc:title></office:meta></office:document-meta>`,
    );
  return zip.generateAsync({ type: 'uint8array' });
}

export interface EpubSpec {
  opfDir: string; // e.g. 'OEBPS' or ''
  title?: string;
  author?: string;
  chapters: Array<{ href: string; html: string }>; // spine order
}

export async function epubBytes(spec: EpubSpec): Promise<Uint8Array> {
  const zip = new JSZip();
  const opfPath = spec.opfDir ? `${spec.opfDir}/content.opf` : 'content.opf';
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    `${XML}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    opfPath,
    `${XML}<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${
      spec.title ? `<dc:title>${spec.title}</dc:title>` : ''
    }${spec.author ? `<dc:creator>${spec.author}</dc:creator>` : ''}</metadata><manifest>${spec.chapters
      .map(
        (c, i) =>
          `<item id="c${i}" href="${c.href}" media-type="application/xhtml+xml"/>`,
      )
      .join('')}</manifest><spine>${spec.chapters
      .map((_, i) => `<itemref idref="c${i}"/>`)
      .join('')}</spine></package>`,
  );
  for (const c of spec.chapters) {
    const p = decodeURIComponent(c.href);
    zip.file(spec.opfDir ? `${spec.opfDir}/${p}` : p, c.html);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

export async function odsBytes(rows: string[][]): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Budget');
  return new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'ods' }));
}
