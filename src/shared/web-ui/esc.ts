/**
 * HTML-escape a string for safe interpolation into HTML. Covers the five
 * characters that matter for both element content and attribute values.
 *
 * Replaces the two private duplicates that used to live in
 * services/registration/src/routes/oauth.ts (htmlEscape) and
 * src/main/remote-mcp/oauth/consent/template.ts (esc).
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
