import { fingerprintOf, normalizeTitle, titleSimilarity } from '../fingerprint';

describe('calendar fingerprints', () => {
  it('normalizeTitle keeps digits and umlauts', () => {
    expect(normalizeTitle('Elternabend, Klasse 7b!')).toBe(
      '7b elternabend klasse',
    );
    expect(normalizeTitle('Zahnärztin  Müller')).toBe('müller zahnärztin');
  });

  it('fingerprint keeps different start times apart', () => {
    const at = (start: string) =>
      fingerprintOf('acc', { title: 'Swimming', start, allDay: false });
    expect(at('2026-11-03T10:00:00Z')).not.toBe(at('2026-11-03T15:00:00Z'));
    expect(at('2026-11-03T10:00:00Z')).toBe(at('2026-11-03T11:00:00+01:00'));
    expect(at('2026-11-03T10:00:00Z')).not.toBe(
      fingerprintOf('other', {
        title: 'Swimming',
        start: '2026-11-03T10:00:00Z',
        allDay: false,
      }),
    );
  });

  it('all-day fingerprint uses the date', () => {
    const fp = (title: string, start: string) =>
      fingerprintOf('acc', { title, start, allDay: true });
    expect(fp('Herbstferien', '2026-10-26')).toBe(
      fp('herbstferien!', '2026-10-26'),
    );
    expect(fp('Herbstferien', '2026-10-26')).not.toBe(
      fp('Herbstferien', '2026-10-27'),
    );
  });

  it('titleSimilarity', () => {
    expect(titleSimilarity('Dentist Dr Weber', 'Dr. Weber dentist')).toBe(1);
    expect(titleSimilarity('Dentist Dr Weber', 'Swimming')).toBe(0);
    expect(titleSimilarity('Swimming lesson', 'Swimming')).toBe(0.5);
  });
});
