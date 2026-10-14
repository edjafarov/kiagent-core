/** Word 97–2003 `.doc` → text via word-extractor (pure-JS OLE reader):
 *  the body, then headers/footers, footnotes, endnotes and comments when
 *  present. Pure. */
interface WordDocument {
  getBody(): string;
  getHeaders(o?: { includeFooters?: boolean }): string;
  getFootnotes(): string;
  getEndnotes(): string;
  getAnnotations(): string;
}

export async function docToMarkdown(bytes: Uint8Array): Promise<string> {
  // CJS default export; a typed require like msgreader in parsers.ts.
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const WordExtractor = require('word-extractor') as new () => {
    extract(input: Buffer): Promise<WordDocument>;
  };
  let doc: WordDocument;
  try {
    doc = await new WordExtractor().extract(Buffer.from(bytes));
  } catch (e) {
    throw e instanceof Error ? e : new Error(`doc: ${String(e)}`);
  }
  const sections: Array<[string, string]> = [
    ['', doc.getBody()],
    ['Headers and footers', doc.getHeaders({ includeFooters: true })],
    ['Footnotes', doc.getFootnotes()],
    ['Endnotes', doc.getEndnotes()],
    ['Comments', doc.getAnnotations()],
  ];
  return sections
    .map(([h, t]) => [h, t.replace(/\r\n?/g, '\n').trim()] as const)
    .filter(([, t]) => t)
    .map(([h, t]) => (h ? `## ${h}\n\n${t}` : t))
    .join('\n\n');
}
