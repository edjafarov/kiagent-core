import {
  makeNativeImageDownscaler,
  passthroughDownscaler,
  VLM_MAX_EDGE,
  type NativeImageModule,
} from '../downscale';

/** Fake nativeImage: records what it was asked to do and returns sized
 *  buffers, so the policy can be asserted without decoding a real image. */
function fakeNativeImage(opts: {
  width: number;
  height: number;
  empty?: boolean;
  jpegBytes?: number;
  pngBytes?: number;
  throws?: boolean;
}): { mod: NativeImageModule; resizeCalls: unknown[]; encoded: string[] } {
  const resizeCalls: unknown[] = [];
  const encoded: string[] = [];
  const mod: NativeImageModule = {
    createFromBuffer() {
      if (opts.throws) throw new Error('decode blew up');
      return {
        isEmpty: () => opts.empty ?? false,
        getSize: () => ({ width: opts.width, height: opts.height }),
        resize(o) {
          resizeCalls.push(o);
          return {
            toJPEG(q: number) {
              encoded.push(`jpeg:${q}`);
              return Buffer.alloc(opts.jpegBytes ?? 1000);
            },
            toPNG() {
              encoded.push('png');
              return Buffer.alloc(opts.pngBytes ?? 1000);
            },
          };
        },
      };
    },
  };
  return { mod, resizeCalls, encoded };
}

const bigInput = new Uint8Array(10 * 1024 * 1024);

describe('passthroughDownscaler', () => {
  it('returns the input untouched', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(passthroughDownscaler(bytes, 'image/png')).resolves.toEqual({
      bytes,
      mime: 'image/png',
    });
  });
});

describe('makeNativeImageDownscaler', () => {
  it('clamps the LONGEST edge and preserves aspect ratio by omitting the other', async () => {
    const wide = fakeNativeImage({ width: 5152, height: 3864 });
    const r = await makeNativeImageDownscaler(wide.mod)(bigInput, 'image/jpeg');
    expect(wide.resizeCalls).toEqual([
      { width: VLM_MAX_EDGE, quality: 'good' },
    ]);
    expect(r.bytes.length).toBe(1000);
    expect(r.mime).toBe('image/jpeg');

    const tall = fakeNativeImage({ width: 3864, height: 5152 });
    await makeNativeImageDownscaler(tall.mod)(bigInput, 'image/jpeg');
    expect(tall.resizeCalls).toEqual([
      { height: VLM_MAX_EDGE, quality: 'good' },
    ]);
  });

  it('leaves an already-small image alone — no decode-and-re-encode tax', async () => {
    const small = fakeNativeImage({ width: VLM_MAX_EDGE, height: 400 });
    const bytes = new Uint8Array(5000);
    const r = await makeNativeImageDownscaler(small.mod)(bytes, 'image/jpeg');
    expect(small.resizeCalls).toEqual([]);
    expect(small.encoded).toEqual([]);
    expect(r.bytes).toBe(bytes);
  });

  it('keeps PNG as PNG — JPEG would flatten alpha to black', async () => {
    const png = fakeNativeImage({ width: 4000, height: 3000, pngBytes: 2000 });
    const r = await makeNativeImageDownscaler(png.mod)(bigInput, 'image/png');
    expect(png.encoded).toEqual(['png']);
    expect(r.mime).toBe('image/png');
  });

  it('returns the ORIGINAL bytes when the image cannot be decoded', async () => {
    const empty = fakeNativeImage({ width: 0, height: 0, empty: true });
    const r = await makeNativeImageDownscaler(empty.mod)(bigInput, 'image/gif');
    expect(r.bytes).toBe(bigInput);
    expect(r.mime).toBe('image/gif');
  });

  it('returns the ORIGINAL bytes when the decoder throws — a clamp must never lose the image', async () => {
    const boom = fakeNativeImage({ width: 4000, height: 3000, throws: true });
    const r = await makeNativeImageDownscaler(boom.mod)(bigInput, 'image/jpeg');
    expect(r.bytes).toBe(bigInput);
  });

  it('refuses a re-encode that did not actually shrink', async () => {
    const grew = fakeNativeImage({
      width: 4000,
      height: 3000,
      jpegBytes: bigInput.length + 1,
    });
    const r = await makeNativeImageDownscaler(grew.mod)(bigInput, 'image/jpeg');
    expect(r.bytes).toBe(bigInput);
  });
});
