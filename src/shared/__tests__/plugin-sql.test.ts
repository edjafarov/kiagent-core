import { formatPluginSql, pluginIdentifier } from '../plugin-sql';

describe('plugin SQL identifiers', () => {
  it('uses the complete UTF-8 plugin id to avoid collisions', () => {
    expect(pluginIdentifier('a.b-c', 'settings')).not.toBe(
      pluginIdentifier('a-b.c', 'settings'),
    );
  });

  it('formats explicit logical markers while preserving quoted text/comments', () => {
    expect(
      formatPluginSql(
        'kiagent.people',
        "SELECT '{{people}}', id FROM {{people}} -- {{unknown}}",
        ['people'],
      ),
    ).toBe(
      `SELECT '{{people}}', id FROM ${pluginIdentifier('kiagent.people', 'people')} -- {{unknown}}`,
    );
  });

  it('rejects unknown markers', () => {
    expect(() =>
      formatPluginSql('kiagent.people', 'SELECT * FROM {{other}}', ['people']),
    ).toThrow();
  });

  it('rejects malformed markers in SQL code', () => {
    expect(() => formatPluginSql('a.b', 'SELECT * FROM {{people', ['people'])).toThrow();
  });
});
