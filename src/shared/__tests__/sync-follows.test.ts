import { FOLLOWS_USER } from '../sync-follows';
import { USER_PREF_KEYS } from '../user-pref-keys';

const keys = FOLLOWS_USER.flatMap((g) => g.keys);

it('every USER_PREF_KEYS entry has a label', () => {
  for (const k of USER_PREF_KEYS) {
    const row = FOLLOWS_USER.find((g) => g.keys.includes(`core.${k}`));
    expect(row?.label).toBeTruthy();
  }
});

it('lists the extension set, every meetings field and the documents description once, each row labelled', () => {
  expect(keys).toContain('core.extensions');
  for (const f of ['enabled', 'summaryInstructions', 'language', 'accuracyRetry', 'joinRecord', 'joinRead', 'silencedApps', 'audioRetentionDays'])
    expect(keys).toContain(`kiagent.meetings.${f}`);
  expect(keys).toContain('kiagent.documents.description');
  expect(new Set(keys).size).toBe(keys.length);
  for (const g of FOLLOWS_USER) expect(g.label).not.toBe('');
});
