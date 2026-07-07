export interface GitHubRef {
  owner: string;
  repo: string;
  tag?: string;
}

const RE = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@(.+))?$/;

export function parseGitHubRef(ref: string): GitHubRef | null {
  const m = RE.exec(ref);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ...(m[3] ? { tag: m[3] } : {}) };
}

export function formatGitHubRef(owner: string, repo: string): string {
  return `github:${owner}/${repo}`;
}
