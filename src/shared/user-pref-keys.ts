/** Preferences that belong to the user and follow them to every device (spec
 *  7.9). They live in the copied table `user_prefs` under `core.<key>`; the
 *  rest stay in `prefs.json` on this machine. */
export const USER_PREF_KEYS = ['outbound', 'calendar', 'features', 'theme'] as const;
export type UserPrefKey = (typeof USER_PREF_KEYS)[number];
