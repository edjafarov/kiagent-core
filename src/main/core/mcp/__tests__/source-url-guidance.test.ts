/** @jest-environment node */
import { buildThreadUrl } from '../../../sources/gmail/to-document';
import {
  toDocument as localFolderToDocument,
  type LocalFolderItem,
} from '../../../sources/local-folder/to-document';
import { KIA_INSTRUCTIONS } from '../instructions';
import { getDescription } from '../tools/get';
import { SCHEMA_DOC } from '../tools/schema-doc';
import { searchDescription } from '../tools/search';

/**
 * The "point back to the original" descriptive layer: a document's `url`
 * (wire name `source_url`) is a deep link the assistant is supposed to hand
 * to the user, and NOTHING surfaces it unless the tool descriptions,
 * schema doc and server instructions say so.
 *
 * These assertions are deliberately paired with checks against the real
 * source builders, so the prose stays pinned to what the code actually
 * emits rather than to a remembered claim.
 */
describe('source_url guidance', () => {
  const documents = SCHEMA_DOC.tables.find((t) => t.name === 'documents');
  const col = (name: string): string =>
    documents!.columns.find((c) => c.name === name)!.notes;

  describe('the claims are true of the current builders', () => {
    it('local-folder emits a file:// url and metadata.absPath', () => {
      const item: LocalFolderItem = {
        absPath: '/Users/me/Docs/report.pdf',
        externalId: '/Users/me/Docs/report.pdf',
        size: 42,
        mtimeIso: '2026-01-01T00:00:00.000Z',
        createdIso: '2026-01-01T00:00:00.000Z',
        ext: 'pdf',
        mime: 'application/pdf',
        markdownText: null,
        binary: null,
      };
      const built = localFolderToDocument(item)!;
      expect(built.url).toBe('file:///Users/me/Docs/report.pdf');
      const meta = built.metadata as Record<string, unknown>;
      expect(meta.absPath).toBe('/Users/me/Docs/report.pdf');
      expect(meta.filename).toBe('report.pdf');
      expect(meta.mime).toBe('application/pdf');
      expect(meta.sizeBytes).toBe(42);
    });

    it('gmail emits a mail.google.com deep link', () => {
      expect(buildThreadUrl('me@example.com', 'abc123')).toMatch(
        /^https:\/\/mail\.google\.com\//,
      );
    });
  });

  describe('documents.url column note', () => {
    it('spells out the per-source deep-link semantics', () => {
      const notes = col('url');
      expect(notes).toContain('mail.google.com');
      expect(notes).toContain('file://');
      expect(notes).toMatch(/absolute (file )?path/i);
      expect(notes).toMatch(/imap/i);
      expect(notes).toMatch(/NULL|empty/);
    });
  });

  describe('documents.metadata column note', () => {
    it('names the per-source keys an agent can rely on', () => {
      const notes = col('metadata');
      expect(notes).toContain('Polymorphic');
      expect(notes).toContain('absPath');
      expect(notes).toContain('filename');
      expect(notes).toContain('mime');
      expect(notes).toContain('sizeBytes');
    });
  });

  describe('tool descriptions', () => {
    it('search tells the model every hit carries source_url', () => {
      expect(searchDescription).toContain('source_url');
      expect(searchDescription).toContain('file://');
    });

    it('get tells the model source_url is a deep link', () => {
      expect(getDescription).toContain('source_url');
      expect(getDescription).toContain('file://');
    });
  });

  describe('server instructions', () => {
    it('tell the assistant to hand source_url to the user', () => {
      expect(KIA_INSTRUCTIONS).toContain('source_url');
      expect(KIA_INSTRUCTIONS).toContain('file://');
      expect(KIA_INSTRUCTIONS).toMatch(/empty/i);
    });

    it('name the field get_related actually returns, and the raw path', () => {
      // get_related projects the internal Document rows verbatim — the link
      // is `url` there, NOT the `source_url` wire name search/get use.
      expect(KIA_INSTRUCTIONS).toMatch(/get_related[^.]*\burl\b/);
      // `url` is percent-escaped (file://${encodeURI(absPath)}); the raw
      // filesystem path an agent should show the user is metadata.absPath.
      expect(KIA_INSTRUCTIONS).toContain('absPath');
    });
  });
});
