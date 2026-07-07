import { schemaGuidance, schemaFields } from '../prompt-guidance';

describe('schemaGuidance', () => {
  test('parses intro and well-formed x-steps', () => {
    const g = schemaGuidance({
      type: 'object',
      description: 'Paste a token from your own internal Slack app.',
      'x-steps': [
        {
          title: 'Create the Slack app',
          body: 'Create New App → From a manifest → paste this:',
          link: 'https://api.slack.com/apps?new_app=1',
          copy: 'display_information:\n  name: KIAgent\n',
        },
        { title: 'Install to your workspace' },
      ],
    });
    expect(g.intro).toBe('Paste a token from your own internal Slack app.');
    expect(g.steps).toEqual([
      {
        title: 'Create the Slack app',
        body: 'Create New App → From a manifest → paste this:',
        link: 'https://api.slack.com/apps?new_app=1',
        copy: 'display_information:\n  name: KIAgent\n',
      },
      {
        title: 'Install to your workspace',
        body: undefined,
        link: undefined,
        copy: undefined,
      },
    ]);
  });

  test('skips steps without a string title', () => {
    const g = schemaGuidance({
      'x-steps': [
        { body: 'no title' },
        'nonsense',
        null,
        { title: '   ' },
        { title: 'Ok' },
      ],
    });
    expect(g.steps.map((s) => s.title)).toEqual(['Ok']);
  });

  test('drops non-https links', () => {
    const g = schemaGuidance({
      'x-steps': [
        { title: 'A', link: 'http://insecure.example' },
        // eslint-disable-next-line no-script-url -- verifying schemaGuidance rejects this
        { title: 'B', link: 'javascript:alert(1)' },
        { title: 'C', link: 'https://ok.example' },
      ],
    });
    expect(g.steps.map((s) => s.link)).toEqual([
      undefined,
      undefined,
      'https://ok.example',
    ]);
  });

  test('tolerates junk: non-object schema, non-array x-steps, missing description', () => {
    expect(schemaGuidance(null)).toEqual({ intro: undefined, steps: [] });
    expect(schemaGuidance('x')).toEqual({ intro: undefined, steps: [] });
    expect(schemaGuidance({ 'x-steps': 'not-an-array' }).steps).toEqual([]);
    expect(schemaGuidance({ description: 42 }).intro).toBeUndefined();
  });
});

describe('schemaFields', () => {
  test('keeps existing conventions: title label, password format/heuristic, folder formats', () => {
    const fields = schemaFields({
      properties: {
        password: {
          type: 'string',
          title: 'User OAuth Token (xoxp-…)',
          format: 'password',
        },
        apiToken: { type: 'string' },
        dir: { type: 'string', format: 'folder-path' },
        dirs: { type: 'array', format: 'folder-paths' },
        plainField: { type: 'string' },
      },
    });
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatchObject({
      key: 'password',
      label: 'User OAuth Token (xoxp-…)',
      secret: true,
    });
    expect(fields[1]).toMatchObject({
      key: 'apiToken',
      label: 'Api Token',
      secret: true,
    });
    expect(fields[2]).toMatchObject({ key: 'dir', folder: true });
    expect(fields[3]).toMatchObject({ key: 'dirs', folderPaths: true });
    expect(fields[4]).toMatchObject({
      key: 'plainField',
      label: 'Plain Field',
      secret: false,
    });
  });

  test('examples[0] becomes placeholder, description becomes help', () => {
    const [f] = schemaFields({
      properties: {
        host: {
          type: 'string',
          title: 'IMAP server hostname',
          description: 'Ask your email provider if unsure.',
          examples: ['imap.example.com'],
        },
      },
    });
    expect(f.placeholder).toBe('imap.example.com');
    expect(f.help).toBe('Ask your email provider if unsure.');
  });

  test('non-string examples[0] and description are ignored', () => {
    const [f] = schemaFields({
      properties: { port: { type: 'number', examples: [993], description: 7 } },
    });
    expect(f.placeholder).toBeUndefined();
    expect(f.help).toBeUndefined();
  });

  test('returns [] for junk schemas', () => {
    expect(schemaFields(null)).toEqual([]);
    expect(schemaFields({ properties: 'x' })).toEqual([]);
  });
});
