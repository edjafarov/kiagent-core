import {
  describeHost,
  hostBudget,
  readHostFacts,
  WEAK_MAX_MEM_BYTES,
  type HostFacts,
} from '../host-profile';

const GiB = 1024 ** 3;
const mac = (o: Partial<HostFacts> = {}): HostFacts => ({
  platform: 'darwin',
  arch: 'arm64',
  cores: 8,
  totalMemBytes: 16 * GiB,
  ...o,
});

describe('hostBudget', () => {
  it('a strong Mac on Metal is not weak', () => {
    expect(hostBudget(mac(), 'metal', {})).toEqual({
      weak: false,
      backgroundThreads: 4,
      ingestSlots: 2,
    });
  });
  it('4 logical cores is weak', () => {
    expect(hostBudget(mac({ cores: 4 }), 'metal', {}).weak).toBe(true);
  });
  it('exactly 8 GiB is weak', () => {
    expect(
      hostBudget(mac({ totalMemBytes: WEAK_MAX_MEM_BYTES }), 'metal', {}).weak,
    ).toBe(true);
  });
  it('a local model on CPU is weak', () => {
    expect(hostBudget(mac({ platform: 'win32' }), 'cpu', {}).weak).toBe(true);
  });
  it('unknown accel off darwin counts as CPU (no GPU probe yet)', () => {
    expect(hostBudget(mac({ platform: 'win32' }), null, {}).weak).toBe(true);
  });
  it('unknown accel on darwin is Metal', () => {
    expect(hostBudget(mac(), null, {}).weak).toBe(false);
  });
  it('vulkan off darwin with enough cores/RAM is not weak', () => {
    expect(hostBudget(mac({ platform: 'win32' }), 'vulkan', {}).weak).toBe(
      false,
    );
  });
  it('backgroundThreads floors at 1', () => {
    expect(hostBudget(mac({ cores: 1 }), 'metal', {}).backgroundThreads).toBe(
      1,
    );
  });
  it('KIA_HOST_WEAK overrides both ways', () => {
    expect(hostBudget(mac(), 'metal', { KIA_HOST_WEAK: '1' }).weak).toBe(true);
    expect(
      hostBudget(mac({ cores: 2 }), 'cpu', { KIA_HOST_WEAK: '0' }).weak,
    ).toBe(false);
  });
});

describe('readHostFacts', () => {
  it('takes injected probes verbatim', () => {
    expect(
      readHostFacts({
        platform: 'linux',
        arch: 'x64',
        cores: 2,
        totalMemBytes: 1,
      }),
    ).toEqual({ platform: 'linux', arch: 'x64', cores: 2, totalMemBytes: 1 });
  });
  it('fills missing probes from the live host', () => {
    const f = readHostFacts();
    expect(f.cores).toBeGreaterThan(0);
    expect(f.totalMemBytes).toBeGreaterThan(0);
  });
});

it('describeHost renders one boot log line with the budget', () => {
  expect(describeHost(mac(), null, {})).toBe(
    'cores=8 mem=16.0GB platform=darwin-arm64 accel=unknown weak=false backgroundThreads=4 ingestSlots=2',
  );
  expect(describeHost(mac({ platform: 'win32' }), 'cpu', {})).toContain(
    'accel=cpu weak=true',
  );
});

describe('ingestSlots', () => {
  it.each([
    ['strong Mac', mac(), 2],
    ['4 logical cores', mac({ cores: 4 }), 1],
    ['exactly 8 GiB', mac({ totalMemBytes: WEAK_MAX_MEM_BYTES }), 1],
    [
      '16-core Windows desktop (CPU accel would make it weak for enrichment)',
      mac({
        platform: 'win32',
        arch: 'x64',
        cores: 16,
        totalMemBytes: 32 * GiB,
      }),
      2,
    ],
  ])('%s → %d', (_name, facts, slots) => {
    expect(hostBudget(facts, 'cpu', {}).ingestSlots).toBe(slots);
  });

  it('ignores the onCpu term that makes every non-Mac weak for enrichment', () => {
    const win = mac({ platform: 'win32', cores: 16, totalMemBytes: 32 * GiB });
    const b = hostBudget(win, null, {});
    expect(b.weak).toBe(true);
    expect(b.ingestSlots).toBe(2);
  });

  it('KIA_HOST_WEAK overrides it both ways', () => {
    expect(hostBudget(mac(), 'metal', { KIA_HOST_WEAK: '1' }).ingestSlots).toBe(
      1,
    );
    expect(
      hostBudget(mac({ cores: 2 }), 'metal', { KIA_HOST_WEAK: '0' })
        .ingestSlots,
    ).toBe(2);
  });
});
