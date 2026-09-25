import { describeResetOutcome } from '../reset-outcome';

const names: Record<string, string> = {
  'kiagent.documents': 'Documents',
  'kiagent.meetings': 'Meetings',
};
const nameOf = (id: string) => names[id] ?? id;
const f = (pluginId: string) => ({ pluginId, error: 'x' });

describe('describeResetOutcome (alpha-cent#192)', () => {
  it('a clean reset says everything was wiped', () => {
    expect(
      describeResetOutcome(
        { ok: true, coreWiped: true, failed: [], error: null },
        nameOf,
      ),
    ).toBe('All local data was wiped.');
  });

  it('a reset stopped before the core wipe never claims a wipe, and never claims a restore', () => {
    const text = describeResetOutcome(
      {
        ok: false,
        coreWiped: false,
        failed: [f('kiagent.documents')],
        error: null,
      },
      nameOf,
    );
    expect(text).toMatch(/did not finish/);
    expect(text).toMatch(/Documents could not be reset/);
    expect(text).toMatch(/accounts and search index were not touched/);
    expect(text).toMatch(/already deleted/);
    expect(text).toMatch(/Reset again/);
    expect(text).not.toMatch(/was wiped|restored/);
  });

  it('a reset stopped by an error before the core wipe names the error', () => {
    const text = describeResetOutcome(
      { ok: false, coreWiped: false, failed: [], error: 'reset batch failed' },
      nameOf,
    );
    expect(text).toMatch(/did not finish: reset batch failed/);
    expect(text).toMatch(/not touched/);
  });

  it('core wiped but extensions did not start again: wiped, and names them', () => {
    const text = describeResetOutcome(
      {
        ok: false,
        coreWiped: true,
        failed: [f('kiagent.documents'), f('kiagent.meetings')],
        error: null,
      },
      nameOf,
    );
    expect(text).toMatch(/^All local data was wiped/);
    expect(text).toMatch(/Documents and Meetings did not start again/);
    expect(text).not.toMatch(/not touched/);
  });

  it('core wiped but a follow-up step failed: wiped, and names the error', () => {
    const text = describeResetOutcome(
      { ok: false, coreWiped: true, failed: [], error: 'vacuum unavailable' },
      nameOf,
    );
    expect(text).toMatch(/^All local data was wiped/);
    expect(text).toMatch(/vacuum unavailable/);
  });
});
