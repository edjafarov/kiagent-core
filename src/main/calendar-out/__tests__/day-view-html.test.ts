/** @jest-environment node */
import { dayViewHtml } from '../day-view-html';
import type { Block, DayModel } from '../day-model';

const block = (over: Partial<Block> = {}): Block => ({
  y: 600,
  h: 60,
  lane: 0,
  lanes: 1,
  title: 'Standup',
  time: '10:00–11:00',
  color: '#3f51b5',
  category: 'work',
  declined: false,
  draft: false,
  outline: null,
  ...over,
});

const model = (over: Partial<DayModel> = {}): DayModel => ({
  date: '2026-10-23',
  dayLabel: 'Friday 23 October',
  timeZone: 'Europe/Berlin',
  dayStartMs: 0,
  dayLenMin: 1440,
  hours: [
    { y: 0, label: '00:00' },
    { y: 60, label: '01:00' },
    { y: 120, label: '02:00' },
  ],
  allDay: [],
  blocks: [],
  more: 0,
  proposed: {
    title: 'Call with Roman',
    y: 690,
    h: 44,
    lane: 0,
    lanes: 1,
    allDay: false,
    continues: false,
    time: '11:30–12:15',
  },
  scrollPx: 600,
  line: { kind: 'free', text: 'Free — nothing else at this time' },
  alsoOn: [],
  notes: [],
  busyClash: false,
  ...over,
});

describe('dayViewHtml', () => {
  it('escapes titles, notes and chips', () => {
    const html = dayViewHtml(
      model({
        blocks: [block({ title: '<b>x</b>' })],
        allDay: [
          {
            title: '<img src=x onerror=1>',
            color: '#33b679',
            category: null,
            declined: false,
            draft: false,
            proposed: false,
          },
        ],
        notes: ['Not checked: <i>Cal</i> (a@b.c)'],
        proposed: { ...model().proposed, title: '<script>alert(1)</script>' },
      }),
    );
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<i>Cal');
    expect(html).not.toContain('<script>alert');
  });

  it('replaces a malicious colour with the fallback', () => {
    const html = dayViewHtml(
      model({
        blocks: [block({ color: 'red;position:fixed' })],
        allDay: [
          {
            title: 'T',
            color: 'red;position:fixed',
            category: null,
            declined: false,
            draft: false,
            proposed: false,
          },
        ],
      }),
    );
    expect(html).not.toContain('position:fixed');
    expect(html).toContain('--c:#4285f4');
  });

  it('splits overlapping blocks into lanes of half width', () => {
    const html = dayViewHtml(
      model({
        blocks: [
          block({ title: 'A', lane: 0, lanes: 2 }),
          block({ title: 'B', lane: 1, lanes: 2 }),
        ],
      }),
    );
    expect(html).toContain('left:calc(0% + 2px);width:calc(50% - 5px)');
    expect(html).toContain('left:calc(50% + 2px);width:calc(50% - 5px)');
  });

  it('draws the proposed block with the Proposed tag, band and data-scroll', () => {
    const html = dayViewHtml(model({ scrollPx: 600 }));
    expect(html).toContain('dv-prop');
    expect(html).toContain('>Proposed<');
    expect(html).toContain('Call with Roman');
    expect(html).toContain('dv-band');
    expect(html).toContain('id="ev-day"');
    expect(html).toContain('data-scroll="600"');
  });

  it('outlines clashes and omits the time line on short blocks', () => {
    const html = dayViewHtml(
      model({
        blocks: [
          block({ title: 'Hit', outline: 'busy' }),
          block({ title: 'Maybe', outline: 'maybe', y: 100 }),
          block({ title: 'Tiny', h: 20, y: 200, time: '09:00–09:20' }),
        ],
      }),
    );
    expect(html).toContain('dv-busy');
    expect(html).toContain('dv-maybe');
    expect(html).toContain('10:00–11:00');
    expect(html).not.toContain('09:00–09:20');
  });

  it('shows all-day chips, +N more and notes under the grid', () => {
    const html = dayViewHtml(
      model({
        allDay: [
          {
            title: 'Mia — school trip',
            color: '#f4511e',
            category: 'kids',
            declined: false,
            draft: false,
            proposed: false,
          },
        ],
        more: 3,
        alsoOn: ['Also on Sat 24 Oct: Fair (all day)'],
        notes: ['Not checked: Family (me@x.com)'],
      }),
    );
    expect(html).toContain('Mia — school trip');
    expect(html).toContain('+3 more');
    expect(html).toContain('Also on Sat 24 Oct');
    expect(html).toContain('Not checked: Family (me@x.com)');
  });
});
