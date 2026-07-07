import type {
  Cap,
  OAuthProviderId,
  OAuthSourceBinding,
} from '@shared/contracts';

export interface CapInfo {
  label: string;
  description: string;
  risk: 'normal' | 'elevated';
  icon: string;
}

/** Renderer-side registry of what each capability means to a human.
 *  `query` is elevated: it reads the entire indexed corpus — and combined
 *  with `net`, an extension could send that data elsewhere. The description
 *  says so plainly (the consent modal is the exfiltration-awareness moment). */
export const CAP_CATALOG: Record<Cap, CapInfo> = {
  query: {
    label: 'Read your indexed documents',
    description:
      'Can read everything KIAgent has indexed, across all your accounts. ' +
      'Combined with internet access, an extension could send that data elsewhere — ' +
      'only grant this to extensions you trust.',
    risk: 'elevated',
    icon: 'search',
  },
  net: {
    label: 'Access the internet',
    description: 'Can make network requests to any host.',
    risk: 'normal',
    icon: 'external',
  },
  files: {
    label: 'Access approved folders',
    description:
      'Not yet supported in this build — calls fail even if granted.',
    risk: 'normal',
    icon: 'folder',
  },
  db: {
    label: 'Keep its own private database',
    description:
      'Stores its own data in a private database, separate from your documents.',
    risk: 'normal',
    icon: 'database',
  },
  ui: {
    label: 'Show notifications',
    description: 'Can show system notifications.',
    risk: 'normal',
    icon: 'info',
  },
  commands: {
    label: 'Register commands',
    description:
      'Not yet supported in this build — calls fail even if granted.',
    risk: 'normal',
    icon: 'settings',
  },
  inference: {
    label: 'Use your AI models',
    description: 'Can run prompts against the models configured in KIAgent.',
    risk: 'normal',
    icon: 'spark',
  },
  events: {
    label: 'React to platform events',
    description: 'Can send and receive signals shared between extensions.',
    risk: 'normal',
    icon: 'log',
  },
};

/** Renderer-side registry of what an OAuth provider binding means to a
 *  human. Rendered wherever caps are (install/update/review consent and
 *  the marketplace detail view): a third-party source signing in through
 *  the platform's provider client is a permission the user must see BEFORE
 *  install — the provider's own consent screen alone attributes the request
 *  to KIAgent, not to the extension that chose the scopes. */
export const OAUTH_PROVIDER_INFO: Record<
  OAuthProviderId,
  { label: string; icon: string }
> = {
  google: { label: 'Google', icon: 'link' },
  microsoft: { label: 'Microsoft', icon: 'link' },
};

/** One consent row per provider, listing the source ids that use it. */
export function groupOAuthSources(
  oauthSources: OAuthSourceBinding[],
): Array<{ provider: OAuthProviderId; ids: string[] }> {
  const grouped = new Map<OAuthProviderId, string[]>();
  for (const s of oauthSources) {
    const ids = grouped.get(s.provider) ?? [];
    ids.push(s.id);
    grouped.set(s.provider, ids);
  }
  return [...grouped].map(([provider, ids]) => ({ provider, ids }));
}
