/** @jest-environment node */
import {
  BAD_INPUT,
  NOT_GITHUB,
  parseInstallLink,
  parseRepoInput,
  provenanceOf,
  repoText,
  toGithubRef,
} from '../install-link';

describe('parseRepoInput', () => {
  it.each([
    ['https://github.com/Owner/Repo', { owner: 'Owner', repo: 'Repo' }],
    ['https://github.com/Owner/Repo/', { owner: 'Owner', repo: 'Repo' }],
    ['https://github.com/Owner/Repo.git', { owner: 'Owner', repo: 'Repo' }],
    ['HTTPS://GitHub.com/o/r', { owner: 'o', repo: 'r' }],
    [
      'https://github.com/o/r/releases/tag/v1.0.0',
      { owner: 'o', repo: 'r', tag: 'v1.0.0' },
    ],
    ['  o/r  ', { owner: 'o', repo: 'r' }],
    ['o/r@V1.2.0', { owner: 'o', repo: 'r', tag: 'V1.2.0' }],
    ['github:o/r@t', { owner: 'o', repo: 'r', tag: 't' }],
    ['github:o/my.repo_x-1', { owner: 'o', repo: 'my.repo_x-1' }],
  ])('accepts %s', (input, want) => {
    expect(parseRepoInput(input)).toEqual(want);
  });

  it.each([
    'https://gitlab.com/a/b',
    'http://github.com/a/b',
    'https://www.github.com/a/b',
  ])('rejects %s as not GitHub', (input) => {
    expect(parseRepoInput(input)).toEqual({ error: NOT_GITHUB });
  });

  it.each([
    'https://u:p@github.com/a/b',
    'https://github.com:443/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#f',
    'https://github.com/a',
    'https://github.com/a/b/tree/main',
    '../x',
    'a/..',
    'a/.',
    'a/b/c',
    'a%2Fb/c',
    '-o/r',
    `${'o'.repeat(40)}/r`,
    'o/r@a/b',
    'o/r@',
    'o/r\u0007',
    '',
    'github:../..',
  ])('rejects %j as bad input', (input) => {
    expect(parseRepoInput(input)).toEqual({ error: BAD_INPUT });
  });
});

describe('parseInstallLink', () => {
  it.each([
    ['kiagent://install?repo=o/r', { owner: 'o', repo: 'r' }],
    [
      'kiagent://install/?repo=o/r&tag=v1',
      { owner: 'o', repo: 'r', tag: 'v1' },
    ],
    ['KIAGENT://install?repo=Own/Repo', { owner: 'Own', repo: 'Repo' }],
    ['kiagent://install?repo=o%2Fr', { owner: 'o', repo: 'r' }],
  ])('accepts %s', (url, want) => {
    expect(parseInstallLink(url, 'kiagent')).toEqual(want);
  });

  it.each([
    'kiagent://other?repo=o/r',
    'kiagent://install?repo=o/r&repo=a/b',
    'kiagent://install?repo=o/r&tag=a&tag=b',
    'kiagent://install?repo=o/r&x=1',
    'kiagent://install',
    'kiagent://install?tag=v1',
    'https://install?repo=o/r',
    'kiagent://install/path?repo=o/r',
    'kiagent://install?repo=o/r#frag',
    `kiagent://install?repo=o/r&tag=${'a'.repeat(500)}`,
    'kiagent://install?repo=o%2Fr%2F..',
    'kiagent://install?repo=..%2Fr',
    'kiagent://user@install?repo=o/r',
    'not a url',
  ])('rejects %s', (url) => {
    expect(parseInstallLink(url, 'kiagent')).toBeNull();
  });
});

describe('toGithubRef / repoText', () => {
  it('formats with and without a tag', () => {
    expect(toGithubRef({ owner: 'o', repo: 'r' })).toBe('github:o/r');
    expect(toGithubRef({ owner: 'o', repo: 'r', tag: 'v1' })).toBe(
      'github:o/r@v1',
    );
    expect(repoText({ owner: 'o', repo: 'r', tag: 'v1' })).toBe('o/r@v1');
  });
});

describe('provenanceOf', () => {
  it.each([
    ['github:kia-plugins/x@v1', { kind: 'store' }],
    ['github:KIA-PLUGINS/x', { kind: 'store' }],
    [
      'github:attacker/kia-plugins',
      { kind: 'github', owner: 'attacker', repo: 'kia-plugins' },
    ],
    [
      'github:kia-plugins-evil/x@v1',
      { kind: 'github', owner: 'kia-plugins-evil', repo: 'x' },
    ],
    ['file:/x/y', { kind: 'local' }],
    ['https://x/a.tgz', { kind: 'url' }],
    [undefined, { kind: 'url' }],
    ['github:../..', { kind: 'url' }],
  ])('%s', (ref, want) => {
    expect(provenanceOf(ref)).toEqual(want);
  });
});
