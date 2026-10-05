/** L0 fixture corpus for the agentic local Kia eval (spec 2026-10-05).
 *  Shapes follow the real connectors: gmail threads with `## N — from · date`
 *  headings and createdAt = last message; calendar events with UTC `When`
 *  and createdAt = start; meeting transcripts as `## Summary … ## Transcript`;
 *  slack days as one `HH:MM sender: text` line per message.
 *  "Today" is Monday 2026-10-05 in Europe/Berlin (UTC+2). */
import type { DocumentInput } from '@shared/contracts';

export const TODAY = '2026-10-05';
export const TZ = 'Europe/Berlin';
export const NOW_ISO = '2026-10-05T10:00:00.000Z'; // 12:00 local
export const ME = 'Alex Meyer <alex@northwind.io>';

type Msg = { from: string; to: string[]; at: string; body: string };

const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');

function thread(
  id: string,
  subject: string,
  msgs: Msg[],
  labels: string[] = ['INBOX'],
): DocumentInput {
  const sections = [
    `# ${subject}\n`,
    `> Thread: ${msgs.length} messages · ${fmt(msgs[0].at)} → ${fmt(msgs[msgs.length - 1].at)}`,
    `> Open in Gmail: https://mail.google.com/mail/#all/${id}\n\n---`,
    ...msgs.map(
      (m, i) => `## ${i + 1} — ${m.from} · ${fmt(m.at)}\n\n${m.body}`,
    ),
  ];
  const participants = [...new Set(msgs.flatMap((m) => [m.from, ...m.to]))];
  return {
    externalId: id,
    type: 'email.thread',
    title: subject,
    markdown: sections.join('\n'),
    url: `https://mail.google.com/mail/#all/${id}`,
    createdAt: msgs[msgs.length - 1].at,
    metadata: {
      from: msgs[0].from,
      to: msgs[0].to,
      labels,
      participants,
      messageCount: msgs.length,
      messages: msgs.map((m) => ({
        id: `${id}-${m.at}`,
        from: m.from,
        date: m.at,
        snippet: m.body.slice(0, 200),
      })),
    },
  };
}

function event(
  id: string,
  title: string,
  start: string,
  end: string,
  attendees: Array<[string, string]> = [],
  description = '',
  occurrenceKey = `${id}@google.com`,
): DocumentInput {
  const att = attendees.map(([name, email]) => ({
    email,
    name,
    response: 'accepted',
  }));
  const lines = [
    `# ${title}`,
    '',
    `**When:** ${start} – ${end}`,
    '**Calendar:** alex@northwind.io',
    ...(att.length
      ? [
          `**Attendees:** ${att.map((a) => `${a.name} <${a.email}> (accepted)`).join(', ')}`,
        ]
      : []),
    ...(description ? ['', description] : []),
  ];
  return {
    externalId: id,
    type: 'calendar.event',
    title,
    markdown: lines.join('\n'),
    createdAt: start,
    metadata: {
      start,
      end,
      allDay: false,
      occurrenceKey,
      attendees: att,
      participants: att.map((a) => a.email),
      timeZone: TZ,
    },
  };
}

function transcript(
  id: string,
  title: string,
  at: string,
  summary: string,
  lines: string[],
  occurrenceKey?: string,
): DocumentInput {
  return {
    externalId: id,
    type: 'meeting.transcript',
    title,
    markdown: `# ${title}\n\n## Summary\n\n${summary}\n\n## Transcript\n\n${lines.join('\n')}`,
    createdAt: at,
    metadata: occurrenceKey ? { calendarEvent: { occurrenceKey } } : {},
  };
}

function file(
  id: string,
  type: string,
  title: string,
  at: string,
  body: string,
): DocumentInput {
  return {
    externalId: id,
    type,
    title,
    markdown: `# ${title}\n\n${body}`,
    createdAt: at,
    metadata: { filename: title },
  };
}

function slackDay(
  id: string,
  channel: string,
  day: string,
  lines: string[],
): DocumentInput {
  return {
    externalId: id,
    type: 'slack.day',
    title: `#${channel} — ${day}`,
    markdown: `# #${channel} — ${day}\n\n${lines.join('\n')}`,
    createdAt: `${day}T18:00:00.000Z`,
    metadata: { channel },
  };
}

const BOB = 'Bob Stone <bob@acme.com>';
const CARLA = 'Carla Diaz <carla@northwind.io>';
const SARAH_C = 'Sarah Chen <sarah.chen@globex.com>';
const DANA = 'Dana Lee <dana@northwind.io>';
const ALEX = ME;

/** Filler that pushes the decisive message past a head clip. */
const ramble = (topic: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `Point ${i + 1} on ${topic}: we compared catering options, room sizes, travel times from Munich and Berlin, hotel blocks near the venue, AV equipment, the evening programme, accessibility, the budget split between teams and the backup plan if the weather turns. Nothing here is decided yet; it is background for the discussion.`,
  ).join('\n\n');

export const GMAIL: DocumentInput[] = [
  thread('t-acme-renewal', 'Acme renewal', [
    {
      from: BOB,
      to: ['alex@northwind.io'],
      at: '2026-09-20T09:12:00.000Z',
      body: 'Hi Alex, for the renewal we propose a 20% price increase on a 3-year term. Let me know. Bob',
    },
    {
      from: ALEX,
      to: ['bob@acme.com'],
      at: '2026-09-24T14:03:00.000Z',
      body: 'Bob, 20% is too much for us. Could you do 10%?',
    },
    {
      from: BOB,
      to: ['alex@northwind.io'],
      at: '2026-10-02T08:40:00.000Z',
      body: 'Alex, final offer: 12% if you sign the 3-year term by Thursday, October 8. After that the 20% stands. Bob',
    },
  ]),
  thread('t-offsite', 'Offsite planning', [
    {
      from: CARLA,
      to: ['team@northwind.io'],
      at: '2026-09-14T10:00:00.000Z',
      body: `We are planning the November offsite in Lisbon. ${ramble('Lisbon', 4)}`,
    },
    {
      from: DANA,
      to: ['team@northwind.io'],
      at: '2026-09-18T11:00:00.000Z',
      body: `Lisbon works for engineering. ${ramble('engineering logistics', 4)}`,
    },
    {
      from: CARLA,
      to: ['team@northwind.io'],
      at: '2026-09-25T09:00:00.000Z',
      body: `Lisbon venue is booked for Nov 18–20. ${ramble('the agenda', 4)}`,
    },
    {
      from: CARLA,
      to: ['team@northwind.io'],
      at: '2026-10-03T16:30:00.000Z',
      body: 'Change of plan: the Lisbon venue cancelled on us. The offsite moves to Porto, same dates (Nov 18–20), at Hotel Infante Sagres. Please rebook travel to Porto.',
    },
  ]),
  thread('t-invoice', 'Invoice INV-2291', [
    {
      from: 'CloudHost Billing <billing@cloudhost.io>',
      to: ['alex@northwind.io'],
      at: '2026-09-28T06:00:00.000Z',
      body: 'Your invoice INV-2291 for €1,840.00 is due on October 15, 2026.',
    },
  ]),
  thread('t-school', 'Autumn holidays', [
    {
      from: 'Grundschule Am Park <office@gs-ampark.de>',
      to: ['alex@northwind.io'],
      at: '2026-09-15T07:30:00.000Z',
      body: 'Dear parents, the autumn holidays run from October 19 to October 30. School resumes on Monday, November 2.',
    },
  ]),
  thread('t-hiring', 'Re: Hiring – backend role', [
    {
      from: DANA,
      to: ['alex@northwind.io'],
      at: '2026-10-01T15:20:00.000Z',
      body: 'Good news: Priya Nair accepted the backend offer. She starts on November 2. I will set up her onboarding.',
    },
  ]),
  thread('t-dinner', 'Dinner Friday?', [
    {
      from: 'Sarah Klein <sarah@klein-family.de>',
      to: ['alex@northwind.io'],
      at: '2026-10-04T18:05:00.000Z',
      body: 'Dinner on Friday at 7pm at Trattoria Roma? Bring Sam!',
    },
  ]),
  thread('t-globex-pricing', 'Pricing feedback', [
    {
      from: SARAH_C,
      to: ['alex@northwind.io'],
      at: '2026-09-29T12:00:00.000Z',
      body: 'Hi Alex, our team thinks the Pro tier at €49 per seat is too expensive. We would need a volume discount above 50 seats to move forward. Sarah',
    },
  ]),
  thread('t-flight', 'Booking confirmation LH1234', [
    {
      from: 'Lufthansa <noreply@lufthansa.com>',
      to: ['alex@northwind.io'],
      at: '2026-09-30T19:00:00.000Z',
      body: 'Flight LH1234 Munich (MUC) → Lisbon (LIS), October 14, departing 08:15. Return LH1235 on October 17 at 18:40. Booking code QX7P2M.',
    },
  ]),
  thread('t-acme-kickoff', 'Acme kickoff notes', [
    {
      from: BOB,
      to: ['alex@northwind.io'],
      at: '2026-06-10T10:00:00.000Z',
      body: 'Thanks for the kickoff. As agreed: pilot for 3 months, 40 seats.',
    },
  ]),
  thread('t-board', 'Board meeting prep', [
    {
      from: 'Jordan Park <jordan@northwind.io>',
      to: ['alex@northwind.io'],
      at: '2026-10-03T09:00:00.000Z',
      body: 'Alex, the board meets on October 9. Please send me the Q3 numbers by October 7.',
    },
  ]),
  ...Array.from({ length: 12 }, (_, i) =>
    thread(
      `t-news-${i}`,
      `Weekly digest #${40 + i}`,
      [
        {
          from: 'Product Weekly <news@productweekly.com>',
          to: ['alex@northwind.io'],
          at: `2026-09-${String(10 + i).padStart(2, '0')}T06:00:00.000Z`,
          body: `This week in product: pricing pages, onboarding flows, retention tactics and a case study on renewal negotiations (issue ${40 + i}).`,
        },
      ],
      ['CATEGORY_PROMOTIONS'],
    ),
  ),
];

export const CALENDAR: DocumentInput[] = [
  event(
    'e-dentist',
    'Dentist',
    '2026-10-06T07:00:00.000Z',
    '2026-10-06T07:45:00.000Z',
    [],
    'Dr. Weber, Hauptstr. 3',
  ),
  event(
    'e-standup-tue',
    'Team standup',
    '2026-10-06T08:00:00.000Z',
    '2026-10-06T08:15:00.000Z',
    [['Dana Lee', 'dana@northwind.io']],
    '',
    'standup@google.com|2026-10-06',
  ),
  event(
    'e-deploy',
    'Deploy window',
    '2026-10-05T23:00:00.000Z',
    '2026-10-06T00:00:00.000Z',
    [['Dana Lee', 'dana@northwind.io']],
    'Release 4.2 goes out.',
  ),
  event(
    'e-tokyo',
    'Call with Tokyo office',
    '2026-10-06T22:30:00.000Z',
    '2026-10-06T23:30:00.000Z',
    [['Ken Sato', 'ken@northwind.jp']],
  ),
  event(
    'e-yoga',
    'Yoga',
    '2026-10-05T16:00:00.000Z',
    '2026-10-05T17:00:00.000Z',
  ),
  event(
    'e-standup-mon',
    'Team standup',
    '2026-10-05T08:00:00.000Z',
    '2026-10-05T08:15:00.000Z',
    [['Dana Lee', 'dana@northwind.io']],
    '',
    'standup@google.com|2026-10-05',
  ),
  event(
    'e-brunch',
    'Brunch with Sarah Klein',
    '2026-10-04T09:00:00.000Z',
    '2026-10-04T11:00:00.000Z',
  ),
  event(
    'e-acme-call',
    'Acme renewal call',
    '2026-10-08T13:00:00.000Z',
    '2026-10-08T13:45:00.000Z',
    [['Bob Stone', 'bob@acme.com']],
    'Renewal terms.',
    'acme-renewal@google.com|2026-10-08',
  ),
  event(
    'e-globex-qbr',
    'Globex QBR',
    '2026-10-12T09:00:00.000Z',
    '2026-10-12T10:00:00.000Z',
    [['Sarah Chen', 'sarah.chen@globex.com']],
    '',
    'globex-qbr@google.com|2026-10-12',
  ),
  event(
    'e-board',
    'Board meeting',
    '2026-10-09T08:00:00.000Z',
    '2026-10-09T11:00:00.000Z',
    [['Jordan Park', 'jordan@northwind.io']],
  ),
  event(
    'e-onboarding',
    'Onboarding Priya',
    '2026-11-02T08:00:00.000Z',
    '2026-11-02T09:00:00.000Z',
    [
      ['Priya Nair', 'priya@northwind.io'],
      ['Dana Lee', 'dana@northwind.io'],
    ],
    'First day for Priya (backend).',
  ),
];

export const MEETINGS: DocumentInput[] = [
  transcript(
    'm-acme-prev',
    'Acme renewal call',
    '2026-09-10T13:00:00.000Z',
    'Topics: pilot results, renewal timing.\nDecisions: the pilot is extended until the renewal is signed.\nAction items: Bob sends a pricing proposal; Alex checks the budget for a 3-year term.',
    [
      'Bob: The pilot went well, 40 seats active.',
      'Alex: Good. Send me a proposal and I will check budget.',
    ],
    'acme-renewal@google.com|2026-09-10',
  ),
  transcript(
    'm-product-sync',
    'Weekly product sync',
    '2026-10-01T09:00:00.000Z',
    'Topics: roadmap, hiring.\nDecisions: feature X (bulk export) is delayed to Q1 2027.\nAction items: Dana drafts the hiring plan.',
    [
      'Dana: We cannot ship bulk export this quarter.',
      'Alex: Then we move it to Q1.',
    ],
  ),
  transcript(
    'm-globex-qbr',
    'Globex QBR',
    '2026-07-12T09:00:00.000Z',
    'Topics: adoption, security.\nDecisions: none.\nAction items: Northwind delivers SSO (SAML) by Q4; Sarah Chen shares their IdP details.',
    [
      'Sarah: SSO is a hard requirement for us before renewal.',
      'Alex: We will have SAML SSO by Q4.',
    ],
    'globex-qbr@google.com|2026-07-12',
  ),
];

export const FILES: DocumentInput[] = [
  file(
    'f-q3',
    'file',
    'Q3 numbers.xlsx',
    '2026-10-02T10:00:00.000Z',
    'Q3 2026 revenue: €412,000. Churn: 3.1%. New customers: 18.',
  ),
  file(
    'f-offsite-agenda',
    'gdocs.doc',
    'Offsite agenda draft',
    '2026-09-26T10:00:00.000Z',
    'Offsite in Lisbon, Nov 18–20. Day 1 strategy, day 2 workshops, day 3 team activity.',
  ),
  file(
    'f-pricing-2027',
    'gdocs.doc',
    'Pricing 2027 proposal',
    '2026-09-30T10:00:00.000Z',
    'Proposal: raise the Pro tier from €49 to €55 per seat in 2027; Team tier unchanged at €19.',
  ),
  file(
    'f-handbook',
    'file',
    'Employee handbook.pdf',
    '2026-03-01T10:00:00.000Z',
    'Vacation policy: 28 days. Remote work: up to 3 days a week.',
  ),
];

export const SLACK: DocumentInput[] = [
  slackDay('s-sales-1002', 'sales', '2026-10-02', [
    '09:12 Mia Wong: Globex says SSO is the blocker for their renewal.',
    '09:15 Alex Meyer: Noted, SAML is planned for Q4.',
  ]),
  slackDay('s-eng-1005', 'eng', '2026-10-05', [
    '10:02 Dana Lee: Heads-up, the 4.2 deploy moved to tonight, 01:00 (Tuesday).',
    '10:05 Alex Meyer: Thanks.',
  ]),
];

/** Source id → documents, as committed per account. */
export const ACCOUNTS: Array<{
  source: string;
  identifier: string;
  docs: DocumentInput[];
}> = [
  { source: 'gmail', identifier: 'alex@northwind.io', docs: GMAIL },
  {
    source: 'google-calendar',
    identifier: 'alex@northwind.io',
    docs: CALENDAR,
  },
  { source: 'meetings', identifier: 'local', docs: MEETINGS },
  { source: 'google-drive', identifier: 'alex@northwind.io', docs: FILES },
  { source: 'slack', identifier: 'northwind', docs: SLACK },
];
