/** User- and model-facing strings of calendar-out, kept in one place. */

export const UNKNOWN_COPY =
  'may have been added — check your calendar, then Try again or Discard';

export const reconnectCopy = (account: string): string =>
  `reconnect ${account} in Settings to allow adding events`;

export const notIndexedCopy = (calendar: string, account: string): string =>
  `Kia doesn't sync the calendar "${calendar}" yet — add it under Sources › ${account} › Calendars first, so Kia can see what is already there`;

export const NO_WRITER_NOTE =
  "Kia can't add events to this kind of calendar yet";

export const TOO_FAR_COPY =
  "can't see that far ahead — Kia sees about 300 days of calendar";

export const PENDING_CAP_COPY = (n: number): string =>
  `${n} event drafts are already waiting for this account — ask the user to review the Outbox first`;

export const INSTRUCTION = {
  review:
    'Event drafted — nothing was added yet. It waits in the Outbox in KIAgent, where the user reviews it and adds it to the calendar. Tell the user what you drafted.',
  link: 'Event drafted — nothing was added yet. Show the user this link; they add it to the calendar from there.',
  inProgress:
    'This event was already confirmed by the user — it is being added, may already be in the calendar, or is waiting in the Outbox for Try again. Do not draft it again.',
  existing:
    'This event was already drafted — the same draft is returned. Do not draft it again.',
  alreadyInCalendar:
    'This event is already in the calendar — nothing was drafted. Report it as "already in the calendar".',
  dismissed:
    'The user dismissed this event before — nothing was drafted. Report it as "dismissed before"; only re-propose (force: true) if the user explicitly asks again.',
} as const;
