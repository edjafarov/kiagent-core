import {
  sourceBrand,
  clientBrand,
  meetingAppBrand,
  initialsOf,
  sourceCategory,
  SOURCE_CATEGORIES,
} from '..';

describe('sourceBrand', () => {
  it('uses the table for a known source', () => {
    expect(sourceBrand('gmail')).toMatchObject({
      key: 'gmail',
      name: 'Gmail',
      color: '#d93025',
      icon: 'mail',
    });
    expect(sourceBrand('ms365')).toMatchObject({
      key: 'm365',
      color: '#0b4f9c',
    });
    expect(sourceBrand('claude-code')).toMatchObject({
      key: 'claude',
      name: 'Claude Code',
    });
  });

  it('prefers a declared colour, keeping the table icon', () => {
    expect(sourceBrand('gmail', { declaredColor: '#123456' })).toMatchObject({
      color: '#123456',
      icon: 'mail',
    });
  });

  it('ignores a declared value that is not a hex colour', () => {
    expect(
      sourceBrand('gmail', { declaredColor: 'red; background:url(x)' }).color,
    ).toBe('#d93025');
  });

  it('shows a manifest image for an unknown source', () => {
    expect(
      sourceBrand('acme-crm', {
        name: 'Acme CRM',
        iconDataUrl: 'data:image/png;base64,AA',
      }),
    ).toEqual({
      key: 'acme-crm',
      name: 'Acme CRM',
      color: null,
      imageUrl: 'data:image/png;base64,AA',
    });
  });

  it('falls back to initials on neutral, never a guessed colour', () => {
    expect(sourceBrand('acme-crm', { name: 'Acme CRM' })).toEqual({
      key: 'acme-crm',
      name: 'Acme CRM',
      color: null,
      initials: 'AC',
    });
  });
});

describe('clientBrand', () => {
  it.each([
    ['Anthropic/ClaudeAI', 'Claude.ai', 'claude'],
    ['claude-ai', 'Claude Desktop', 'claude'],
    ['claude-code', 'Claude Code', 'claude'],
    ['openai-mcp', 'ChatGPT', 'openai'],
    ['codex-mcp-client', 'Codex', 'openai'],
    ['cursor-vscode', 'Cursor', 'cursor'],
    ['Visual Studio Code', 'VS Code', 'vscode'],
    // the local app adapters' ids
    ['claude-desktop', 'Claude Desktop', 'claude'],
    ['cursor', 'Cursor', 'cursor'],
    ['vscode', 'VS Code', 'vscode'],
    ['codex', 'Codex', 'openai'],
  ])('maps %s to %s', (raw, name, key) => {
    expect(clientBrand(raw)).toMatchObject({ name, key });
  });

  it('keeps an unknown raw id as the name, neutral', () => {
    expect(clientBrand('my-agent')).toEqual({
      key: 'my-agent',
      name: 'my-agent',
      color: null,
      initials: 'MA',
    });
  });
});

describe('meetingAppBrand', () => {
  it('maps meeting apps, browsers and manual recordings', () => {
    expect(meetingAppBrand('Zoom')).toMatchObject({
      key: 'zoom',
      color: '#0b5cff',
    });
    expect(meetingAppBrand('Teams')).toMatchObject({ key: 'teams' });
    expect(meetingAppBrand('Chrome')).toMatchObject({
      key: 'browser',
      name: 'Chrome',
      icon: 'globe',
    });
    expect(meetingAppBrand('Slack')).toMatchObject({ key: 'slack' });
    expect(meetingAppBrand(null)).toMatchObject({
      key: 'manual',
      name: 'Recording',
      icon: 'mic',
    });
    expect(meetingAppBrand('Webex')).toMatchObject({
      key: 'webex',
      color: null,
      initials: 'We',
    });
  });
});

describe('initialsOf', () => {
  it('takes two words, or the first two letters', () => {
    expect(initialsOf('Google Calendar')).toBe('GC');
    expect(initialsOf('fixture')).toBe('Fi');
    expect(initialsOf('')).toBe('?');
  });
});

describe('sourceCategory', () => {
  it('files a known source under its category, anything else under other', () => {
    expect(sourceCategory('gmail')).toBe('mail');
    expect(sourceCategory('claude-code')).toBe('ai-sessions');
    expect(sourceCategory('some-new-thing')).toBe('other');
  });
  it('lists every category once, other last', () => {
    const keys = SOURCE_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[keys.length - 1]).toBe('other');
  });
});
