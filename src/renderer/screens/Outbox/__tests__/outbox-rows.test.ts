import { sendPresets } from '../outbox-rows';

const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();
const keys = (now: number) => sendPresets(now).map((p) => p.key);
const preset = (now: number, key: string) =>
  new Date(sendPresets(now).find((p) => p.key === key)!.at);

describe('sendPresets', () => {
  it('a morning offers the rest of today, tomorrow and Monday', () => {
    // Thu 22 Oct 2026, 08:00
    expect(keys(at(2026, 10, 22, 8))).toEqual([
      'in15',
      'in60',
      'in180',
      'afternoon',
      'evening',
      'tomorrow-am',
      'tomorrow-pm',
      'monday',
    ]);
  });

  it('today’s choices go once their hour is near', () => {
    expect(keys(at(2026, 10, 22, 12, 59))).toContain('afternoon');
    expect(keys(at(2026, 10, 22, 13, 0))).not.toContain('afternoon');
    expect(keys(at(2026, 10, 22, 16, 59))).toContain('evening');
    const late = keys(at(2026, 10, 22, 22));
    expect(late).not.toContain('afternoon');
    expect(late).not.toContain('evening');
  });

  it('"In" choices round up to the next whole minute', () => {
    const now = at(2026, 10, 22, 10, 7) + 30_000;
    expect(preset(now, 'in15').getTime()).toBe(at(2026, 10, 22, 10, 23));
    expect(preset(now, 'in60').getTime()).toBe(at(2026, 10, 22, 11, 8));
  });

  it('Monday is left out when tomorrow is Monday, and is next week on a Monday', () => {
    expect(keys(at(2026, 10, 25, 10))).not.toContain('monday'); // Sunday
    expect(preset(at(2026, 10, 26, 10), 'monday').getDate()).toBe(2); // Mon → 2 Nov
    expect(preset(at(2026, 10, 23, 10), 'monday').getDate()).toBe(26); // Fri
  });

  it('wall-clock times hold across a daylight-saving change', () => {
    // Sat 24 Oct 2026 20:00; Europe leaves summer time that night.
    const tomorrow = preset(at(2026, 10, 24, 20), 'tomorrow-am');
    expect(tomorrow.getDate()).toBe(25);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);
  });
});
