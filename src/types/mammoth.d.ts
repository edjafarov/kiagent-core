// mammoth ships convertToMarkdown at runtime but omits it from its bundled
// .d.ts (which only declares convertToHtml, extractRawText, etc.).
//
// mammoth uses `export = mammoth` (CJS-style). We augment the module by
// re-exporting a merged type that adds convertToMarkdown. This file must
// stay a script (no top-level import/export) to act as global augmentation.
declare module 'mammoth' {
  function convertToMarkdown(
    input: { buffer: Buffer } | { path: string } | { arrayBuffer: ArrayBuffer },
    options?: {
      styleMap?: string | Array<string>;
      includeEmbeddedStyleMap?: boolean;
      includeDefaultStyleMap?: boolean;
      ignoreEmptyParagraphs?: boolean;
      idPrefix?: string;
    },
  ): Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
}
