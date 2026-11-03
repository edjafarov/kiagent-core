/** What follows the user to every device (alpha-cent spec 7.9), as the Devices
 *  page lists it. Pure data: the renderer imports it as `@shared/sync-follows`. */
export const FOLLOWS_USER: readonly { label: string; keys: string[] }[] = [
  { label: 'Theme', keys: ['core.theme'] },
  { label: 'Outbound mode', keys: ['core.outbound'] },
  { label: 'Calendar defaults', keys: ['core.calendar'] },
  { label: 'Feature switches', keys: ['core.features'] },
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
