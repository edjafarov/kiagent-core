/** What follows the user to every device (alpha-cent spec 7.9), as the Devices
 *  page lists it. Pure data: the renderer imports it as `@shared/sync-follows`. */
import { USER_PREF_KEYS, type UserPrefKey } from './user-pref-keys';

const CORE_LABELS: Record<UserPrefKey, string> = {
  theme: 'Theme',
  outbound: 'Outbound mode',
  calendar: 'Calendar defaults',
  features: 'Feature switches',
};

export const FOLLOWS_USER: readonly { label: string; keys: string[] }[] = [
  ...USER_PREF_KEYS.map((k) => ({ label: CORE_LABELS[k], keys: [`core.${k}`] })),
  { label: 'Connectors on/off', keys: ['core.extensions'] },
  {
    label: 'Meetings settings',
    keys: [
      'enabled',
      'summaryInstructions',
      'language',
      'accuracyRetry',
      'joinRecord',
      'joinRead',
      'silencedApps',
      'audioRetentionDays',
    ].map((f) => `kiagent.meetings.${f}`),
  },
  { label: 'Documents sorting description', keys: ['kiagent.documents.description'] },
];
