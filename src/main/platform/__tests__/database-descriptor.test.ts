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
        {
          version: 1,
          statements: ['CREATE INDEX {{settings_idx}} ON {{settings}} (id)'],
        },
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
        modules: [
          {
            ...GOOD.modules[0],
            migrations: [
              GOOD.modules[0].migrations[1],
              GOOD.modules[0].migrations[0],
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects unknown keys and unregistered logical names', () => {
    expect(() => parseDatabaseDescriptor({ ...GOOD, loader: 'x' })).toThrow();
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        modules: [
          {
            ...GOOD.modules[0],
            migrations: [
              {
                version: 1,
                statements: ['CREATE TABLE {{missing}} (id TEXT)'],
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects duplicate legacy tables and non-table legacy references', () => {
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        legacy: {
          ...GOOD.legacy,
          tables: [
            ...GOOD.legacy.tables,
            { name: 'settings', columns: ['id'] },
          ],
        },
      }),
    ).toThrow(/duplicate legacy table/);
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        legacy: {
          ...GOOD.legacy,
          tables: [{ name: 'settings_idx', columns: ['id'] }],
        },
      }),
    ).toThrow(/registered table object/);
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        legacy: { ...GOOD.legacy, versionTable: 'settings_idx' },
      }),
    ).toThrow(/versionTable/);
  });

  it('requires bootstrap zero only for direct unversioned legacy storage', () => {
    expect(() =>
      parseDatabaseDescriptor({
        ...GOOD,
        modules: [
          {
            ...GOOD.modules[0],
            migrations: [
              {
                version: 1,
                statements: ['CREATE TABLE {{settings}} (id TEXT)'],
              },
            ],
          },
        ],
        legacy: { tables: [{ name: 'settings', columns: ['id'] }] },
      }),
    ).toThrow(/version-zero bootstrap/);
    expect(
      parseDatabaseDescriptor({
        ...GOOD,
        modules: [
          {
            ...GOOD.modules[0],
            migrations: [
              {
                version: 1,
                statements: ['CREATE TABLE {{settings}} (id TEXT)'],
              },
            ],
          },
        ],
        legacy: {
          tables: [{ name: 'settings', columns: ['id'] }],
          versionTable: 'settings',
        },
      }),
    ).toEqual(expect.objectContaining({ modules: expect.any(Array) }));
  });

  it('checks every registered module without inferring table ownership', () => {
    const direct = {
      ...GOOD,
      objects: [{ name: 'oidc_payload', kind: 'table' as const }],
      modules: [
        {
          name: 'oauth',
          migrations: [
            {
              version: 1,
              statements: ['CREATE TABLE {{oidc_payload}} (id TEXT)'],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'oidc_payload', columns: ['id'] }] },
    };
    expect(() => parseDatabaseDescriptor(direct)).toThrow(
      /version-zero bootstrap/,
    );
    expect(
      parseDatabaseDescriptor({
        ...direct,
        modules: [
          {
            ...direct.modules[0],
            migrations: [
              {
                version: 0,
                statements: ['CREATE TABLE {{oidc_payload}} (id TEXT)'],
              },
            ],
          },
        ],
      }),
    ).toEqual(expect.objectContaining({ modules: expect.any(Array) }));
    expect(() => parseDatabaseDescriptor({ ...direct, modules: [] })).toThrow(
      /at least one module/,
    );
  });
});
