import {
  ASR_ACCURACY_TIERS,
  ASR_TIERS,
  WHISPER_BASE_Q5_1,
  WHISPER_LARGE_V3_Q5_0,
  WHISPER_LARGE_V3_TURBO_Q5_0,
  WHISPER_SMALL_Q5_1,
  asrAccel,
  resolveAsrModel,
  selectAccuracyModel,
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

describe('selectAccuracyModel (spec: selective accuracy retry)', () => {
  it('metal at ≥16 GiB gets the non-turbo large-v3 5-bit model', () => {
    expect(
      selectAccuracyModel({ accel: 'metal', totalMemBytes: 16 * GiB }),
    ).toBe(WHISPER_LARGE_V3_Q5_0);
    expect(
      selectAccuracyModel({ accel: 'metal', totalMemBytes: 64 * GiB }),
    ).toBe(WHISPER_LARGE_V3_Q5_0);
  });
  it('is null (unsupported) below 16 GiB or off metal', () => {
    expect(
      selectAccuracyModel({ accel: 'metal', totalMemBytes: 16 * GiB - 1 }),
    ).toBeNull();
    expect(
      selectAccuracyModel({ accel: 'cpu', totalMemBytes: 64 * GiB }),
    ).toBeNull();
  });
  it('pins the exact file, size and digest', () => {
    expect(WHISPER_LARGE_V3_Q5_0.id).toBe('whisper-large-v3-q5_0');
    expect(WHISPER_LARGE_V3_Q5_0.files).toEqual([
      {
        name: 'ggml-large-v3-q5_0.bin',
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-q5_0.bin',
        sha256:
          'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
        sizeBytes: 1081140203,
      },
    ]);
    expect(ASR_ACCURACY_TIERS).toHaveLength(1);
  });
  it('the accuracy id is not an override target (resolveAsrModel stays default-tier only)', () => {
    expect(resolveAsrModel('whisper-large-v3-q5_0')).toBeNull();
  });
  it('the gate is Metal-plus-RAM, not Apple silicon: an Intel Mac reports metal and qualifies at 16 GiB', () => {
    expect(asrAccel('darwin')).toBe('metal');
    expect(
      selectAccuracyModel({
        accel: asrAccel('darwin'),
        totalMemBytes: 16 * GiB,
      }),
    ).toBe(WHISPER_LARGE_V3_Q5_0);
  });
});
