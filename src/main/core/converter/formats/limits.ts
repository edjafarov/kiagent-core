/** Upper bound on one document's markdown, whichever path parsed it. */
export const MAX_MARKDOWN_CHARS = 2 * 1024 * 1024;
export function capMarkdown(md: string): {
  markdown: string;
  truncated: boolean;
} {
  return md.length > MAX_MARKDOWN_CHARS
    ? {
        markdown: `${md.slice(0, MAX_MARKDOWN_CHARS)}\n\n[truncated]`,
        truncated: true,
      }
    : { markdown: md, truncated: false };
}
