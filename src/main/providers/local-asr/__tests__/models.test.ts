import {
  ASR_TIERS,
  WHISPER_BASE_Q5_1,
  WHISPER_LARGE_V3_TURBO_Q5_0,
  WHISPER_SMALL_Q5_1,
  asrAccel,
  resolveAsrModel,
  selectAsrModel,
} from '../models';

const GiB = 1024 ** 3;

describe('asrAccel', () => {
  it('darwin is metal, everything else cpu', () => {
    expect(asrAccel('darwin')).toBe('metal');
    expect(asrAccel('win32')).toBe('cpu');
    expect(asrAccel('linux')).toBe('cpu');
  });
});

describe('selectAsrModel', () => {
  it('metal at ≥16 GiB gets large-v3-turbo', () => {
    expect(selectAsrModel({ accel: 'metal', totalMemBytes: 16 * GiB })).toBe(
      WHISPER_LARGE_V3_TURBO_Q5_0,
    );
    expect(selectAsrModel({ accel: 'metal', totalMemBytes: 64 * GiB })).toBe(
      WHISPER_LARGE_V3_TURBO_Q5_0,
    );
  });

  it('cpu NEVER gets large-v3-turbo, however much RAM (whisper runs on CPU off-darwin — spec §4)', () => {
    expect(selectAsrModel({ accel: 'cpu', totalMemBytes: 64 * GiB })).toBe(
      WHISPER_SMALL_Q5_1,
    );
  });

  it('metal below 16 GiB falls to small', () => {
    expect(
      selectAsrModel({ accel: 'metal', totalMemBytes: 16 * GiB - 1 }),
    ).toBe(WHISPER_SMALL_Q5_1);
  });

  it('8 GiB boundary: small at 8, base below', () => {
    expect(selectAsrModel({ accel: 'cpu', totalMemBytes: 8 * GiB })).toBe(
      WHISPER_SMALL_Q5_1,
    );
    expect(selectAsrModel({ accel: 'cpu', totalMemBytes: 8 * GiB - 1 })).toBe(
      WHISPER_BASE_Q5_1,
    );
  });
});

describe('resolveAsrModel', () => {
  it('resolves only ASR tier ids', () => {
    expect(resolveAsrModel('whisper-small-q5_1')).toBe(WHISPER_SMALL_Q5_1);
    expect(resolveAsrModel('gemma-4-12b-it-Q4_K_M')).toBeNull();
    expect(resolveAsrModel('nonsense')).toBeNull();
  });
});

describe('descriptors', () => {
  it('are single-file with pinned sizes', () => {
    for (const t of ASR_TIERS) expect(t.model.files).toHaveLength(1);
    expect(WHISPER_LARGE_V3_TURBO_Q5_0.files[0].sizeBytes).toBe(574041195);
    expect(WHISPER_SMALL_Q5_1.files[0].sizeBytes).toBe(190085487);
    expect(WHISPER_BASE_Q5_1.files[0].sizeBytes).toBe(59707625);
  });
});
