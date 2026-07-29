import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dayKey/hhmm read local time — pin the process timezone before the module
// under test ever calls `new Date(...)`.
process.env.TZ = 'UTC';

const require = createRequire(import.meta.url);
const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Import through the ROOT STUB (`chat-day.js` -> `dist/chat-day`), i.e.
// exactly the path plugins take with `require('@kiagent/connector-sdk/chat-day')`.
const { dayKey, dayTitle, mergeMessages, renderDay } = require(
  join(sdkRoot, 'chat-day.js'),
);

// --------------------------------------------------------------- dayKey

test('dayKey: local-calendar YYYY-MM-DD for known timestamps', () => {
  assert.equal(dayKey(Date.UTC(2024, 2, 15, 9, 0, 0)), '2024-03-15');
  assert.equal(dayKey(Date.UTC(2023, 11, 31, 23, 59, 0)), '2023-12-31');
  assert.equal(dayKey(Date.UTC(2024, 0, 1, 0, 0, 0)), '2024-01-01');
});

// -------------------------------------------------------------- dayTitle

test('dayTitle: "<chatName> — Mon D, YYYY" for a day key', () => {
  assert.equal(dayTitle('General', '2024-03-15'), 'General — Mar 15, 2024');
  assert.equal(dayTitle('Team', '2023-12-31'), 'Team — Dec 31, 2023');
  assert.equal(dayTitle('Solo', '2024-01-01'), 'Solo — Jan 1, 2024');
});

// ----------------------------------------------------------- mergeMessages

test('mergeMessages: incoming wins on id conflict', () => {
  const existing = [{ id: 'a', tsMs: 100, v: 'old' }];
  const incoming = [{ id: 'a', tsMs: 100, v: 'new' }];
  const merged = mergeMessages(existing, incoming, (m) => m.tsMs);
  assert.deepEqual(merged, [{ id: 'a', tsMs: 100, v: 'new' }]);
});

test('mergeMessages: dedupes across existing+incoming and sorts ascending by ts', () => {
  const existing = [
    { id: 'a', tsMs: 300 },
    { id: 'b', tsMs: 100 },
  ];
  const incoming = [
    { id: 'c', tsMs: 200 },
    { id: 'b', tsMs: 100 }, // duplicate id, same ts — incoming copy wins
  ];
  const merged = mergeMessages(existing, incoming, (m) => m.tsMs);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['b', 'c', 'a'],
  );
});

test('mergeMessages: default comparator is lexical — "10" sorts before "9"', () => {
  const a = [
    { id: '9', tsMs: 100 },
    { id: '10', tsMs: 100 },
  ];
  const merged = mergeMessages(a, [], (m) => m.tsMs);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['10', '9'],
  );
});

test('mergeMessages: injected numeric comparator flips the tie order', () => {
  const a = [
    { id: '9', tsMs: 100 },
    { id: '10', tsMs: 100 },
  ];
  const merged = mergeMessages(
    a,
    [],
    (m) => m.tsMs,
    (x, y) => Number(x) - Number(y),
  );
  assert.deepEqual(
    merged.map((m) => m.id),
    ['9', '10'],
  );
});

// -------------------------------------------------------------- renderDay

test('renderDay: golden output byte-identical to the ported implementation', () => {
  const messages = [
    {
      id: '1',
      tsMs: Date.UTC(2024, 2, 15, 9, 0, 0),
      sender: null,
      text: 'Alice created the group',
      system: true,
    },
    {
      id: '2',
      tsMs: Date.UTC(2024, 2, 15, 9, 5, 0),
      sender: 'Alice',
      text: 'Hello there',
      system: false,
    },
    {
      id: '3',
      tsMs: Date.UTC(2024, 2, 15, 9, 6, 30),
      sender: 'Bob',
      text: 'Sure thing',
      quote: { sender: 'Alice', snippet: 'Hello there' },
      system: false,
    },
    {
      id: '4',
      tsMs: Date.UTC(2024, 2, 15, 10, 15, 0),
      sender: 'Alice',
      text: '',
      media: { kind: 'audio', durationSec: 65 },
      system: false,
    },
    {
      id: '5',
      tsMs: Date.UTC(2024, 2, 15, 11, 0, 0),
      sender: 'Bob',
      text: '',
      media: { kind: 'document', filename: 'report.pdf' },
      system: false,
    },
    {
      id: '6',
      tsMs: Date.UTC(2024, 2, 15, 11, 30, 0),
      sender: 'Alice',
      text: '',
      media: { kind: 'image' },
      system: false,
    },
  ];

  // Golden captured by running the source connector's ORIGINAL renderDay
  // (unmodified chat-day.ts + types.ts copied verbatim to a scratch dir,
  // compiled with tsc, executed under TZ=UTC) against this exact fixture.
  // See task-3-report.md for the full reproduction steps and command output.
  const golden =
    '_Alice created the group_\n' +
    '09:05 Alice: Hello there\n' +
    '09:06 Bob: ↳re Alice: Hello there Sure thing\n' +
    '10:15 Alice: [voice note 1:05]\n' +
    '11:00 Bob: [document: report.pdf]\n' +
    '11:30 Alice: [image]';

  assert.equal(renderDay(messages), golden);
});
