import { isOwner, isRepo, isTag } from '@shared/install-link';

export interface GitHubRef {
  owner: string;
  repo: string;
  tag?: string;
}

const RE = /^github:([^/@]+)\/([^/@]+)(?:@(.+))?$/;

/** `github:owner/repo[@tag]`, with the same component rules as the shared
 *  install-link parser — `github:../..` and friends are not refs. */
export function parseGitHubRef(ref: string): GitHubRef | null {
  const m = RE.exec(ref);
  if (!m || !isOwner(m[1]) || !isRepo(m[2])) return null;
  if (m[3] !== undefined && !isTag(m[3])) return null;
  return { owner: m[1], repo: m[2], ...(m[3] ? { tag: m[3] } : {}) };
}

export function formatGitHubRef(owner: string, repo: string): string {
  return `github:${owner}/${repo}`;
}
