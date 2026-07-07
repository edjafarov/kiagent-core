import { isUnder, toggleSelection } from '../selection';

describe('toggleSelection', () => {
  it('adds then removes the same path (round-trip)', () => {
    const empty = new Map<string, string>();
    const added = toggleSelection(empty, '/a', 'a');
    expect([...added.entries()]).toEqual([['/a', 'a']]);
    const removed = toggleSelection(added, '/a', 'a');
    expect(removed.size).toBe(0);
  });

  it('adding a parent removes previously-added descendants and keeps unrelated roots', () => {
    let map = new Map<string, string>();
    map = toggleSelection(map, '/a/child', 'child');
    map = toggleSelection(map, '/b', 'b');
    map = toggleSelection(map, '/a', 'a');
    expect([...map.keys()].sort()).toEqual(['/a', '/b']);
  });

  it('adding a path covered by an existing root is a no-op returning the same map reference', () => {
    let map = new Map<string, string>();
    map = toggleSelection(map, '/a', 'a');
    const result = toggleSelection(map, '/a/child', 'child');
    expect(result).toBe(map);
  });

  it('is an antichain after arbitrary scripted sequences of add/remove', () => {
    const sequences: Array<Array<{ path: string; name: string }>> = [
      [
        { path: '/a', name: 'a' },
        { path: '/a/b', name: 'b' },
        { path: '/a/b/c', name: 'c' },
        { path: '/d', name: 'd' },
      ],
      [
        { path: '/a/b/c', name: 'c' },
        { path: '/a/b', name: 'b' },
        { path: '/a', name: 'a' },
        { path: '/a', name: 'a' }, // remove it again
        { path: '/a/b', name: 'b' },
      ],
      [
        { path: '/x', name: 'x' },
        { path: '/y', name: 'y' },
        { path: '/z', name: 'z' },
        { path: '/x/1', name: '1' },
        { path: '/y', name: 'y' }, // remove y
        { path: '/w', name: 'w' },
      ],
    ];

    for (const seq of sequences) {
      let map = new Map<string, string>();
      for (const { path, name } of seq) {
        map = toggleSelection(map, path, name);
      }
      const paths = [...map.keys()];
      for (const p of paths) {
        for (const q of paths) {
          if (p === q) continue;
          expect(isUnder(p, q)).toBe(false);
        }
      }
    }
  });

  it('removing a covering root does not resurrect previously-subsumed descendants', () => {
    let map = new Map<string, string>();
    map = toggleSelection(map, '/a/b', 'b');
    map = toggleSelection(map, '/a', 'a'); // subsumes /a/b
    map = toggleSelection(map, '/a', 'a'); // remove /a
    expect(map.has('/a/b')).toBe(false);
    expect(map.size).toBe(0);
  });
});
