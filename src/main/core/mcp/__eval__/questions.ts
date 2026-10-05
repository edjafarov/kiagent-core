/** L0 questions. `all`: every group must match (any alternative in a group,
 *  case-insensitive substring of the final answer). `none`: none may appear
 *  (a wrong or superseded fact stated as the answer). `draft`: the turn must
 *  have drafted a reply on the thread with that externalId, its body
 *  matching every group. */
export interface Question {
  id: string;
  q: string;
  history?: string[];
  all: string[][];
  none?: string[];
  draft?: { thread: string; body: string[][] };
}

const OCT8 = [
  'oct 8',
  'october 8',
  '8 oct',
  '8. oct',
  '10-08',
  '08.10',
  'thursday',
];

export const QUESTIONS: Question[] = [
  {
    id: 'tomorrow',
    q: 'What happens tomorrow?',
    all: [['dentist'], ['standup'], ['deploy']],
    none: ['yoga', 'tokyo', 'brunch'],
  },
  {
    id: 'today',
    q: "What's on my calendar today?",
    all: [['yoga'], ['standup']],
    none: ['dentist', 'brunch'],
  },
  {
    id: 'acme-call-when',
    q: 'When is the Acme renewal call?',
    all: [OCT8, ['15:00', '3 pm', '3pm', '15.00', '3:00 pm', '3:00pm']],
  },
  {
    id: 'acme-final-offer',
    q: 'What price increase did Acme finally offer?',
    all: [['12%', '12 %', '12 percent']],
  },
  {
    id: 'acme-deadline',
    q: 'By when do we need to sign with Acme?',
    all: [OCT8],
  },
  {
    id: 'offsite-where',
    q: 'Where is the November offsite?',
    all: [['porto']],
  },
  {
    id: 'sarah-pricing',
    q: 'What did Sarah say about pricing?',
    all: [['49'], ['volume', '50 seats', 'discount']],
  },
  {
    id: 'invoice',
    q: 'How much is the CloudHost invoice and when is it due?',
    all: [
      ['1,840', '1840', '1.840'],
      ['oct 15', 'october 15', '15 oct', '15. oct', '10-15', '15.10'],
    ],
  },
  {
    id: 'school-holidays',
    q: 'When are the school autumn holidays?',
    all: [['19'], ['30']],
  },
  {
    id: 'priya-start',
    q: 'When does Priya start?',
    all: [['nov 2', 'november 2', '2 nov', '2. nov', '11-02', '02.11']],
  },
  {
    id: 'product-sync',
    q: 'What did we decide in the last product sync?',
    all: [['q1'], ['export', 'feature x']],
  },
  {
    id: 'acme-actions',
    q: 'What were the action items from the last Acme meeting?',
    all: [['proposal'], ['budget']],
  },
  {
    id: 'globex-qbr-ask',
    q: 'What did Globex ask for in the last QBR?',
    all: [['sso', 'saml']],
  },
  {
    id: 'flight',
    q: "What's my flight to Lisbon?",
    all: [
      ['lh1234', 'lh 1234'],
      ['08:15', '8:15'],
      ['oct 14', 'october 14', '14 oct', '14. oct', '10-14', '14.10'],
    ],
  },
  {
    id: 'q3-revenue',
    q: 'What was our Q3 revenue?',
    all: [['412']],
  },
  {
    id: 'my-discount-ask',
    q: 'What discount did I ask Acme for?',
    all: [['10%', '10 %', '10 percent']],
  },
  {
    id: 'board-ask',
    q: 'What does Jordan need from me for the board meeting, and by when?',
    all: [['q3'], ['oct 7', 'october 7', '7 oct', '7. oct', '10-07', '07.10']],
  },
  {
    id: 'board-when',
    q: 'When is the board meeting?',
    all: [
      ['oct 9', 'october 9', '9 oct', '9. oct', '10-09', '09.10', 'friday'],
    ],
  },
  {
    id: 'dinner',
    q: 'Any dinner plans this week?',
    all: [['friday'], ['trattoria', '7pm', '7 pm', '19:00']],
  },
  {
    id: 'slack-globex',
    q: 'What did Mia say in Slack about Globex?',
    all: [['sso', 'saml']],
  },
  {
    id: 'deploy-when',
    q: 'When is the 4.2 deploy?',
    all: [
      ['01:00', '1:00', '1 am', '1am'],
      ['tuesday', 'tonight', 'oct 6', '6 oct'],
    ],
  },
  {
    id: 'count-tomorrow',
    q: 'How many calendar events do I have tomorrow?',
    all: [['3', 'three']],
    none: ['4 events', 'four'],
  },
  {
    id: 'pricing-2027',
    q: "What's the proposed Pro tier price for 2027?",
    all: [['55']],
  },
  {
    id: 'followup-before',
    q: 'And what did he propose before that?',
    history: [
      'Q: What did Bob say in his latest email about the renewal?\nA: Bob offered a 12% increase if you sign the 3-year term by Thursday, October 8 (Acme renewal).',
    ],
    all: [['20%', '20 %', '20 percent']],
  },
  {
    id: 'draft-acme',
    q: 'Draft a reply to Bob saying we accept the 12% and will sign by Thursday.',
    all: [['draft']],
    draft: { thread: 't-acme-renewal', body: [['12']] },
  },
  // Held-out (written after run 1, before the v2 changes were measured).
  { id: 'H-onboarding-who', q: 'Who is joining the onboarding on November 2?', all: [['priya'], ['dana']] },
  { id: 'H-booking-code', q: "What's the booking code for my flight?", all: [['qx7p2m']] },
  { id: 'H-return-flight', q: 'When does my return flight leave?', all: [['18:40', '6:40'], ['oct 17', 'october 17', '17 oct', '17. oct', '10-17', '17.10']] },
  { id: 'H-churn', q: 'What was our churn in Q3?', all: [['3.1']] },
  { id: 'H-dentist-where', q: 'Where is my dentist appointment?', all: [['hauptstr', 'weber']] },
  { id: 'H-vacation', q: 'How many vacation days do we get?', all: [['28']] },
  // Held-out 2 (written before the plan-then-run search ladder was measured;
  // paraphrases and synonyms on purpose).
  { id: 'N-remote', q: 'How many days a week can I work from home?', all: [['3', 'three']] },
  { id: 'N-hotel', q: 'Which hotel are we staying at for the offsite?', all: [['infante sagres']] },
  { id: 'N-pilot-seats', q: 'How many seats did the Acme pilot have?', all: [['40']] },
  { id: 'N-school-back', q: 'When do the kids go back to school after the break?', all: [['nov 2', 'november 2', '2 nov', '2. nov', '11-02', '02.11']] },
  { id: 'N-team-tier', q: 'What does the Team tier cost?', all: [['19']] },
  { id: 'N-tokyo', q: 'When is my call with the Tokyo office, my time?', all: [['00:30', '0:30', '12:30 am', '12:30am']] },
  { id: 'N-sso-promise', q: 'By when did we promise Globex single sign-on?', all: [['q4']] },
  { id: 'N-bring', q: 'Who should I bring to dinner on Friday?', all: [['sam']] },
];

/** Pre-meeting brief fixtures: the calendar event to brief, and the facts a
 *  good brief states. */
export interface BriefCase {
  id: string;
  event: string; // calendar externalId
  all: string[][];
  none?: string[];
}

export const BRIEFS: BriefCase[] = [
  {
    id: 'brief-acme',
    event: 'e-acme-call',
    all: [['12%', '12 %'], OCT8, ['proposal', 'budget']],
  },
  {
    id: 'brief-globex',
    event: 'e-globex-qbr',
    all: [
      ['sso', 'saml'],
      ['49', 'volume', '50 seats'],
    ],
  },
  {
    id: 'brief-onboarding',
    event: 'e-onboarding',
    all: [['backend'], ['nov 2', 'november 2', '2 nov', 'first day']],
  },
];
