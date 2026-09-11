import { parseDatabaseDescriptor } from '../database-descriptor';

const GOOD = {
  format: 1,
  objects: [
    { name: 'settings', kind: 'table' },
    { name: 'settings_idx', kind: 'index' },
  ],
  modules: [
    {
      name: 'settings',
      migrations: [
        { version: 0, statements: ['CREATE TABLE {{settings}} (id TEXT)'] },
        { version: 1, statements: ['CREATE INDEX {{settings_idx}} ON {{settings}} (id)'] },
      ],
    },
  ],
  legacy: {
    tables: [{ name: 'settings', columns: ['id'] }],
    versionTable: 'settings',
  },
};

describe('parseDatabaseDescriptor', () => {
  it('accepts the declarative descriptor format', () => {
    expect(parseDatabaseDescriptor(GOOD)).toEqual(GOOD);
  });

  it('rejects duplicate objects and non-ascending migration versions', () => {
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        objects: [...GOOD.objects, { name: 'settings', kind: 'view' }],
      }),
    ).toThrow();
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        modules: [{ ...GOOD.modules[0], migrations: [GOOD.modules[0].migrations[1], GOOD.modules[0].migrations[0]] }],
      }),
    ).toThrow();
  });

  it('rejects unknown keys and unregistered logical names', () => {
    expect(() => parseDatabaseDescriptor({ ...GOOD, loader: 'x' })).toThrow();
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        modules: [{ ...GOOD.modules[0], migrations: [{ version: 1, statements: ['CREATE TABLE {{missing}} (id TEXT)'] }] }],
      }),
    ).toThrow();
  });
});
