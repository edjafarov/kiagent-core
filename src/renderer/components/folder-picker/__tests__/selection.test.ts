import { isUnder, learnPath, toggleSelection } from '../selection';
import type { SelectionMap } from '../selection';

const empty = (): SelectionMap => new Map();

describe('toggleSelection', () => {
  it('adds then removes the same id (round-trip)', () => {
    const added = toggleSelection(empty(), 'a', 'a', '/a');
    expect([...added.entries()]).toEqual([['a', { name: 'a', path: '/a' }]]);
    const removed = toggleSelection(added, 'a', 'a', '/a');
    expect(removed.size).toBe(0);
  });

  it('adding a parent removes previously-added descendants and keeps unrelated roots', () => {
    let map = empty();
    map = toggleSelection(map, 'child', 'child', '/a/child');
    map = toggleSelection(map, 'b', 'b', '/b');
    map = toggleSelection(map, 'a', 'a', '/a');
    expect([...map.keys()].sort()).toEqual(['a', 'b']);
  });

  it('adding a path covered by an existing root is a no-op returning the same map reference', () => {
    let map = empty();
    map = toggleSelection(map, 'a', 'a', '/a');
    const result = toggleSelection(map, 'child', 'child', '/a/child');
    expect(result).toBe(map);
  });

  it('the same folder reached from two mode tabs selects once, not twice', () => {
    // One Drive folder listed under BOTH "My Drive" and "Shared with me":
    // the adapter synthesizes two different paths for the same id, and
    // neither is a prefix of the other, so coveringRoots cannot collapse
    // them. Identity is the id.
    let map = empty();
    map = toggleSelection(map, 'dup', 'Dup (My Drive)', '/my-dup');
    map = toggleSelection(map, 'dup', 'Dup (Shared)', '/shared-dup');
    expect(map.size).toBe(0); // the second click toggled the SAME folder off
    map = toggleSelection(map, 'dup', 'Dup (My Drive)', '/my-dup');
    expect([...map.keys()]).toEqual(['dup']);
  });

  it('is an antichain after arbitrary scripted sequences of add/remove', () => {
    const sequences: Array<Array<{ id: string; path: string }>> = [
      [
        { id: 'a', path: '/a' },
        { id: 'b', path: '/a/b' },
        { id: 'c', path: '/a/b/c' },
        { id: 'd', path: '/d' },
      ],
      [
        { id: 'c', path: '/a/b/c' },
        { id: 'b', path: '/a/b' },
        { id: 'a', path: '/a' },
        { id: 'a', path: '/a' }, // remove it again
        { id: 'b', path: '/a/b' },
      ],
      [
        { id: 'x', path: '/x' },
        { id: 'y', path: '/y' },
        { id: 'z', path: '/z' },
        { id: 'x1', path: '/x/1' },
        { id: 'y', path: '/y' }, // remove y
        { id: 'w', path: '/w' },
      ],
    ];

    for (const seq of sequences) {
      let map = empty();
      for (const { id, path } of seq) map = toggleSelection(map, id, id, path);
      const paths = [...map.values()].map((e) => e.path as string);
      for (const p of paths) {
        for (const q of paths) {
          if (p === q) continue;
          expect(isUnder(p, q)).toBe(false);
        }
      }
    }
  });

  it('removing a covering root does not resurrect previously-subsumed descendants', () => {
    let map = empty();
    map = toggleSelection(map, 'b', 'b', '/a/b');
    map = toggleSelection(map, 'a', 'a', '/a'); // subsumes /a/b
    map = toggleSelection(map, 'a', 'a', '/a'); // remove /a
    expect(map.has('b')).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe('learnPath', () => {
  it('locates a preselected root and refreshes its name from the listing', () => {
    const map: SelectionMap = new Map([['r', { name: 'stale', path: null }]]);
    const located = learnPath(map, 'r', 'Root One', '/r1');
    expect(located.get('r')).toEqual({ name: 'Root One', path: '/r1' });
  });

  it('drops a preselected root once its row shows it under another selected root', () => {
    const map: SelectionMap = new Map([
      ['a', { name: 'a', path: '/a' }],
      ['child', { name: 'child', path: null }],
    ]);
    expect([...learnPath(map, 'child', 'child', '/a/child').keys()]).toEqual([
      'a',
    ]);
  });

  it('subsumes selected descendants when a preselected ancestor is located', () => {
    const map: SelectionMap = new Map([
      ['child', { name: 'child', path: '/a/child' }],
      ['a', { name: 'a', path: null }],
    ]);
    expect([...learnPath(map, 'a', 'a', '/a').keys()]).toEqual(['a']);
  });

  it('is a no-op for an unselected or already-located id', () => {
    const map: SelectionMap = new Map([['a', { name: 'a', path: '/a' }]]);
    expect(learnPath(map, 'a', 'a', '/a')).toBe(map);
    expect(learnPath(map, 'nope', 'nope', '/nope')).toBe(map);
  });
});
