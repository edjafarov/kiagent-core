/** @jest-environment node */
import { parseGitHubRef, formatGitHubRef } from '../github-ref';

describe('github-ref', () => {
  describe('parseGitHubRef', () => {
    it('parses a simple github ref', () => {
      const result = parseGitHubRef('github:kia-plugins/notion-kia-connector');
      expect(result).toEqual({
        owner: 'kia-plugins',
        repo: 'notion-kia-connector',
      });
    });

    it('parses a github ref with tag', () => {
      const result = parseGitHubRef('github:o/r@v2.0.0');
      expect(result).toEqual({
        owner: 'o',
        repo: 'r',
        tag: 'v2.0.0',
      });
    });

    it('parses refs with special characters in owner and repo', () => {
      const result = parseGitHubRef('github:my-org/my.repo');
      expect(result).toEqual({
        owner: 'my-org',
        repo: 'my.repo',
      });
    });

    it('parses refs with numbers and underscores', () => {
      const result = parseGitHubRef('github:org_name123/repo_name456');
      expect(result).toEqual({
        owner: 'org_name123',
        repo: 'repo_name456',
      });
    });

    it('rejects invalid format without owner/repo', () => {
      expect(parseGitHubRef('github:junk')).toBeNull();
    });

    it('rejects https urls', () => {
      expect(parseGitHubRef('https://github.com/owner/repo')).toBeNull();
    });

    it('rejects simple owner/repo format', () => {
      expect(parseGitHubRef('owner/repo')).toBeNull();
    });

    it('rejects empty string', () => {
      expect(parseGitHubRef('')).toBeNull();
    });

    it('rejects malformed refs', () => {
      expect(parseGitHubRef('github:owner/')).toBeNull();
      expect(parseGitHubRef('github:/repo')).toBeNull();
    });
  });

  describe('formatGitHubRef', () => {
    it('formats owner and repo into github ref', () => {
      const result = formatGitHubRef('kia-plugins', 'notion-kia-connector');
      expect(result).toBe('github:kia-plugins/notion-kia-connector');
    });

    it('formats simple owner and repo', () => {
      const result = formatGitHubRef('o', 'r');
      expect(result).toBe('github:o/r');
    });

    it('round-trips with parseGitHubRef', () => {
      const original = 'github:my-org/my.repo@v1.2.3';
      const parsed = parseGitHubRef(original);
      expect(parsed).not.toBeNull();
      if (parsed) {
        const formatted = formatGitHubRef(parsed.owner, parsed.repo);
        expect(formatted).toBe('github:my-org/my.repo');
      }
    });

    it('round-trips without tag', () => {
      const original = 'github:owner/repo';
      const parsed = parseGitHubRef(original);
      expect(parsed).not.toBeNull();
      if (parsed) {
        const formatted = formatGitHubRef(parsed.owner, parsed.repo);
        expect(formatted).toBe(original);
      }
    });
  });
});
