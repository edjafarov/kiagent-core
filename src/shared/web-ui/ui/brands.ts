/** Brand identity for sources, AI apps and meeting apps. Colours are shown
 *  toned in CSS (`--brand-tone`); nothing stores a toned value. */
export interface Brand {
  key: string;
  name: string;
  /** Raw brand colour; `null` means the neutral slate square. */
  color: string | null;
  icon?: string;
  initials?: string;
  /** A connector's own image, shown on a white square. */
  imageUrl?: string;
}

export const NEUTRAL_BRAND_COLOR = '#64748b';

type Entry = Omit<Brand, 'imageUrl'>;

const SOURCES: Record<string, Entry> = {
  gmail: { key: 'gmail', name: 'Gmail', color: '#d93025', icon: 'mail' },
  imap: { key: 'imap', name: 'Email', color: '#475569', icon: 'mail' },
  'local-folder': {
    key: 'local',
    name: 'Local folder',
    color: '#b26a06',
    icon: 'folder',
  },
  slack: { key: 'slack', name: 'Slack', color: '#4a154b', icon: 'message' },
  whatsapp: {
    key: 'whatsapp',
    name: 'WhatsApp',
    color: '#128c4b',
    icon: 'message',
  },
  telegram: {
    key: 'telegram',
    name: 'Telegram',
    color: '#0a86b3',
    icon: 'send',
  },
  notion: {
    key: 'notion',
    name: 'Notion',
    color: '#191919',
    icon: 'file-text',
  },
  hubspot: { key: 'hubspot', name: 'HubSpot', color: '#d9502b', icon: 'users' },
  'google-docs': {
    key: 'gdocs',
    name: 'Google Docs',
    color: '#1a73e8',
    icon: 'file-text',
  },
  'google-calendar': {
    key: 'gcal',
    name: 'Google Calendar',
    color: '#1a73e8',
    icon: 'calendar',
  },
  ms365: { key: 'm365', name: 'Microsoft 365', color: '#0b4f9c', icon: 'mail' },
  'microsoft-365': {
    key: 'm365',
    name: 'Microsoft 365',
    color: '#0b4f9c',
    icon: 'mail',
  },
  onedrive: {
    key: 'm365',
    name: 'OneDrive',
    color: '#0b4f9c',
    icon: 'folder-open',
  },
  dropbox: {
    key: 'dropbox',
    name: 'Dropbox',
    color: '#0061fe',
    icon: 'folder-open',
  },
  linear: { key: 'linear', name: 'Linear', color: '#5e6ad2', icon: 'layers' },
  instagram: {
    key: 'instagram',
    name: 'Instagram',
    color: '#c13584',
    icon: 'grid',
  },
  'browser-history': {
    key: 'browser',
    name: 'Browser history',
    color: '#475569',
    icon: 'globe',
  },
  'claude-code': {
    key: 'claude',
    name: 'Claude Code',
    color: '#c15f3c',
    icon: 'bot',
  },
  codex: { key: 'openai', name: 'Codex', color: '#0f8a6b', icon: 'bot' },
  meetings: { key: 'mic', name: 'Meetings', color: '#475569', icon: 'mic' },
};

const CLAUDE = '#c15f3c';
const OPENAI = '#0f8a6b';

/** Raw MCP client ids (lower-cased) → display brand. */
const CLIENTS: Record<string, Entry> = {
  'anthropic/claudeai': {
    key: 'claude',
    name: 'Claude.ai',
    color: CLAUDE,
    initials: 'Cl',
  },
  'claude-ai': {
    key: 'claude',
    name: 'Claude Desktop',
    color: CLAUDE,
    initials: 'CD',
  },
  'claude-code': {
    key: 'claude',
    name: 'Claude Code',
    color: CLAUDE,
    initials: 'CC',
  },
  'openai-mcp': {
    key: 'openai',
    name: 'ChatGPT',
    color: OPENAI,
    initials: 'GP',
  },
  'codex-mcp-client': {
    key: 'openai',
    name: 'Codex',
    color: OPENAI,
    initials: 'Cx',
  },
  'cursor-vscode': {
    key: 'cursor',
    name: 'Cursor',
    color: '#1e293b',
    initials: 'Cu',
  },
  'visual studio code': {
    key: 'vscode',
    name: 'VS Code',
    color: '#0a6fc2',
    initials: 'VS',
  },
};

const BROWSERS = new Set([
  'chrome',
  'safari',
  'brave',
  'firefox',
  'edge',
  'arc',
]);

const MEETING_APPS: Record<string, Entry> = {
  zoom: { key: 'zoom', name: 'Zoom', color: '#0b5cff', icon: 'monitor' },
  teams: { key: 'teams', name: 'Teams', color: '#5b5fc7', icon: 'users' },
  'google meet': {
    key: 'meet',
    name: 'Google Meet',
    color: '#188038',
    icon: 'monitor',
  },
  meet: { key: 'meet', name: 'Google Meet', color: '#188038', icon: 'monitor' },
  slack: SOURCES.slack,
  whatsapp: SOURCES.whatsapp,
  telegram: SOURCES.telegram,
};

const HEX = /^#[0-9a-f]{6}$/i;

export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s._/-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const w = words[0];
    return w.charAt(0).toUpperCase() + w.slice(1, 2);
  }
  return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

function neutral(key: string, name: string): Brand {
  return { key, name, color: null, initials: initialsOf(name) };
}

export function sourceBrand(
  sourceId: string,
  opts: { name?: string; declaredColor?: string; iconDataUrl?: string } = {},
): Brand {
  const known = SOURCES[sourceId];
  if (opts.declaredColor && HEX.test(opts.declaredColor)) {
    return {
      ...(known ?? {
        key: sourceId,
        name: opts.name ?? sourceId,
        initials: initialsOf(opts.name ?? sourceId),
      }),
      color: opts.declaredColor,
    };
  }
  if (known) return { ...known };
  const name = opts.name ?? sourceId;
  if (opts.iconDataUrl)
    return { key: sourceId, name, color: null, imageUrl: opts.iconDataUrl };
  return neutral(sourceId, name);
}

export function clientBrand(rawId: string): Brand {
  const known = CLIENTS[rawId.trim().toLowerCase()];
  return known ? { ...known } : neutral(rawId, rawId);
}

export function meetingAppBrand(appName: string | null): Brand {
  if (appName == null)
    return { key: 'manual', name: 'Recording', color: '#475569', icon: 'mic' };
  const id = appName.trim().toLowerCase();
  if (BROWSERS.has(id))
    return { key: 'browser', name: appName, color: '#475569', icon: 'globe' };
  const known = MEETING_APPS[id];
  return known ? { ...known } : neutral(id, appName);
}
