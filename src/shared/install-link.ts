/**
 * Installing a connector from a GitHub repository: the one parser for what
 * a person pastes and for `kiagent://install?repo=…` links, plus where an
 * installed or staged ref came from. Pure — used by main (which re-checks
 * everything) and by the renderer (which only uses it to give early copy).
 */

export interface RepoRef {
  owner: string;
  repo: string;
  tag?: string;
}

export type Provenance =
  | { kind: 'store' }
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'local' }
  | { kind: 'url' };

/** The org whose repositories make up the store. */
export const STORE_OWNER = 'kia-plugins';

export const NOT_GITHUB = 'That isn’t a GitHub repository address.';
export const BAD_INPUT =
  'Use the repository’s address, like github.com/owner/repo.';

const MAX_LINK_LENGTH = 512;

export function isOwner(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s);
}

export function isRepo(s: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..';
}

export function isTag(s: string): boolean {
  return /^[A-Za-z0-9._+-]{1,128}$/.test(s);
}

function valid(owner: string, repo: string, tag?: string): RepoRef | null {
  if (!isOwner(owner) || !isRepo(repo)) return null;
  if (tag !== undefined && !isTag(tag)) return null;
  return tag === undefined ? { owner, repo } : { owner, repo, tag };
}

function decodeOnce(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** `https://github.com/o/r[/|.git|/releases/tag/<t>]`. */
function parseGithubUrl(text: string): RepoRef | { error: string } {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { error: BAD_INPUT };
  }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com')
    return { error: NOT_GITHUB };
  // `new URL` drops a default port (`:443`), so the authority is checked
  // as typed: no userinfo, no port.
  const authority = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  if (/[:@]/.test(authority) || u.search || u.hash) return { error: BAD_INPUT };
  const raw = u.pathname.replace(/^\//, '').replace(/\/$/, '').split('/');
  const parts = raw.map(decodeOnce);
  if (parts.some((p) => p === null)) return { error: BAD_INPUT };
  const seg = parts as string[];
  let r: RepoRef | null = null;
  if (seg.length === 2) {
    r = valid(seg[0], seg[1].replace(/\.git$/, ''));
  } else if (seg.length === 5 && seg[2] === 'releases' && seg[3] === 'tag') {
    r = valid(seg[0], seg[1], seg[4]);
  }
  return r ?? { error: BAD_INPUT };
}

/** What a person typed or pasted, as a repository. */
export function parseRepoInput(text: string): RepoRef | { error: string } {
  const t = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return parseGithubUrl(t);
  const body = t.startsWith('github:') ? t.slice('github:'.length) : t;
  const at = body.indexOf('@');
  const path = at === -1 ? body : body.slice(0, at);
  const tag = at === -1 ? undefined : body.slice(at + 1);
  const seg = path.split('/');
  if (seg.length !== 2) return { error: BAD_INPUT };
  return valid(seg[0], seg[1], tag) ?? { error: BAD_INPUT };
}

/** `<scheme>://install?repo=<owner>/<repo>[&tag=<tag>]`, nothing else. */
export function parseInstallLink(url: string, scheme: string): RepoRef | null {
  if (url.length > MAX_LINK_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${scheme.toLowerCase()}:`) return null;
  if (u.hostname.toLowerCase() !== 'install') return null;
  if (u.username || u.password || u.port || u.hash) return null;
  if (u.pathname !== '' && u.pathname !== '/') return null;
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => k !== 'repo' && k !== 'tag')) return null;
  const repos = u.searchParams.getAll('repo');
  const tags = u.searchParams.getAll('tag');
  if (repos.length !== 1 || tags.length > 1) return null;
  const seg = repos[0].split('/');
  if (seg.length !== 2) return null;
  return valid(seg[0], seg[1], tags[0]);
}

export function toGithubRef(r: RepoRef): string {
  return `github:${repoText(r)}`;
}

/** `owner/repo[@tag]` — the text a link prefills. */
export function repoText(r: RepoRef): string {
  return `${r.owner}/${r.repo}${r.tag ? `@${r.tag}` : ''}`;
}

/** Where a staged or installed package comes from, read from its PINNED
 *  ref (main's canonical resolution), never from what someone typed. */
export function provenanceOf(ref: string | undefined): Provenance {
  if (ref?.startsWith('file:')) return { kind: 'local' };
  if (ref?.startsWith('github:')) {
    const m = /^github:([^/@]+)\/([^/@]+)(?:@.*)?$/.exec(ref);
    if (m && isOwner(m[1]) && isRepo(m[2])) {
      return m[1].toLowerCase() === STORE_OWNER
        ? { kind: 'store' }
        : { kind: 'github', owner: m[1], repo: m[2] };
    }
  }
  return { kind: 'url' };
}
