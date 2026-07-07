export interface PageResult {
  ocrText?: string;
  description?: string;
}

const MAX_MERGED_CHARS = 1_000_000;

// Retrieval-oriented: the description feeds the FTS index and the LLM context.
// Verbatim text is OCR's job — asking the VLM for it too wastes tokens and
// invites hallucinated transcription.
export const INDEXING_PROMPT =
  'You are indexing a personal document archive for search. Describe this ' +
  'image or document page: what it shows, its layout, any charts or tables ' +
  '(summarize what they convey), and the key names, dates, and amounts that ' +
  'appear. Do not transcribe the full text verbatim. Reply with the ' +
  'description only.';

export function mergeExtraction(pages: PageResult[]): string {
  const multi = pages.length > 1;
  const parts: string[] = [];
  pages.forEach((p, i) => {
    const sec: string[] = [];
    const description = p.description?.trim();
    const ocr = p.ocrText?.trim();
    if (description) sec.push(`**Description:** ${description}`);
    if (ocr) sec.push(`**Text content (OCR):**\n\n${ocr}`);
    if (sec.length === 0) return;
    parts.push(
      multi ? [`--- page ${i + 1} ---`, ...sec].join('\n\n') : sec.join('\n\n'),
    );
  });
  return parts.join('\n\n').slice(0, MAX_MERGED_CHARS);
}
