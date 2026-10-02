import {
  decideFileIndexing,
  MAX_CLOUD_BINARY_BYTES,
  MAX_CLOUD_IMAGE_BYTES,
  MAX_LOCAL_AUDIO_BYTES,
  MAX_LOCAL_BINARY_BYTES,
  MAX_LOCAL_TEXT_BYTES,
  MAX_FETCH_BYTES,
  newlyAdmitted,
  FILE_POLICY_VERSION,
} from '../file-indexability';

type Case = [
  string,
  Parameters<typeof decideFileIndexing>[0],
  ReturnType<typeof decideFileIndexing>,
];

const cases: Case[] = [
  [
    'cloud text',
    {
      profile: 'cloud-drive',
      filename: 'a.txt',
      mime: 'text/plain',
      sizeBytes: 10,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud pdf at cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_CLOUD_BINARY_BYTES,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud pdf over cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_CLOUD_BINARY_BYTES + 1,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  [
    'cloud image at cap',
    {
      profile: 'cloud-drive',
      filename: 'a.png',
      mime: 'image/png',
      sizeBytes: MAX_CLOUD_IMAGE_BYTES,
    },
    { kind: 'index', pipeline: 'vision', bytes: 'eager' },
  ],
  [
    'cloud image over cap',
    {
      profile: 'cloud-drive',
      filename: 'a.png',
      mime: 'image/png',
      sizeBytes: MAX_CLOUD_IMAGE_BYTES + 1,
    },
    { kind: 'ignore', reason: 'too-large' },
  ],
  [
    'cloud audio',
    {
      profile: 'cloud-drive',
      filename: 'song.mp3',
      mime: 'audio/mpeg',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'cloud-media' },
  ],
  [
    'cloud audio mime beats txt suffix',
    {
      profile: 'cloud-drive',
      filename: 'song.txt',
      mime: 'audio/mpeg',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'cloud-media' },
  ],
  [
    'cloud video',
    {
      profile: 'cloud-drive',
      filename: 'movie.mp4',
      mime: 'video/mp4',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'cloud-media' },
  ],
  [
    'cloud archive by extension',
    {
      profile: 'cloud-drive',
      filename: 'BACKUP.ZIP',
      mime: 'application/octet-stream',
      sizeBytes: 1,
    },
    { kind: 'ignore', reason: 'archive' },
  ],
  [
    'cloud archive by mime',
    {
      profile: 'cloud-drive',
      filename: 'payload.bin',
      mime: 'application/x-7z-compressed',
      sizeBytes: 1,
    },
    { kind: 'ignore', reason: 'archive' },
  ],
  [
    'cloud unknown',
    {
      profile: 'cloud-drive',
      filename: 'payload.bin',
      mime: 'application/octet-stream',
      sizeBytes: 1,
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'cloud unknown size supported',
    { profile: 'cloud-drive', filename: 'a.pdf', mime: 'application/pdf' },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'local text at cap',
    {
      profile: 'local-folder',
      filename: 'a.ts',
      mime: 'video/mp2t',
      sizeBytes: MAX_LOCAL_TEXT_BYTES,
      path: '/d/a.ts',
    },
    { kind: 'index', pipeline: 'inline-text', bytes: 'eager' },
  ],
  [
    'local text over cap',
    {
      profile: 'local-folder',
      filename: 'a.ts',
      mime: 'video/mp2t',
      sizeBytes: MAX_LOCAL_TEXT_BYTES + 1,
      path: '/d/a.ts',
    },
    { kind: 'index', pipeline: 'inline-text', bytes: 'none' },
  ],
  [
    'local pdf at cap',
    {
      profile: 'local-folder',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_LOCAL_BINARY_BYTES,
      path: '/d/a.pdf',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'local mp3',
    {
      profile: 'local-folder',
      filename: 'meeting.mp3',
      mime: 'audio/mpeg',
      sizeBytes: MAX_LOCAL_AUDIO_BYTES,
      path: '/d/meeting.mp3',
    },
    { kind: 'index', pipeline: 'audio', bytes: 'eager' },
  ],
  [
    'local mp3 over cap',
    {
      profile: 'local-folder',
      filename: 'meeting.mp3',
      mime: 'audio/mpeg',
      sizeBytes: MAX_LOCAL_AUDIO_BYTES + 1,
      path: '/d/meeting.mp3',
    },
    { kind: 'ignore', reason: 'too-large' },
  ],
  [
    'local mp4',
    {
      profile: 'local-folder',
      filename: 'meeting.mp4',
      mime: 'video/mp4',
      sizeBytes: 100,
      path: '/d/meeting.mp4',
    },
    { kind: 'index', pipeline: 'audio', bytes: 'eager' },
  ],
  [
    'local webm video',
    {
      profile: 'local-folder',
      filename: 'movie.webm',
      mime: 'video/webm',
      sizeBytes: 100,
      path: '/d/movie.webm',
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'local archive',
    {
      profile: 'local-folder',
      filename: 'backup.tar.gz',
      mime: 'application/gzip',
      sizeBytes: 1,
      path: '/d/backup.tar.gz',
    },
    { kind: 'ignore', reason: 'archive' },
  ],
  [
    'local no extension',
    {
      profile: 'local-folder',
      filename: 'LICENSE',
      mime: 'text/plain',
      sizeBytes: 10,
      path: '/d/LICENSE',
    },
    { kind: 'ignore', reason: 'no-extension' },
  ],
  [
    'local noindex',
    {
      profile: 'local-folder',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: 10,
      path: '/d/CACHE.noindex/a.pdf',
    },
    { kind: 'ignore', reason: 'sensitive' },
  ],
  [
    'local credential',
    {
      profile: 'local-folder',
      filename: '.env.production',
      mime: 'text/plain',
      sizeBytes: 10,
      path: '/d/.env.production',
    },
    { kind: 'ignore', reason: 'sensitive' },
  ],
  // The local PDF ladder. Middle row is the regression guard: today a 30 MiB
  // local PDF is committed metadata-only and OCR'd by the vision worker, and a
  // single 20 MiB cap would delete that path and archive PDFs already OCR'd.
  [
    'local pdf over converter cap is deferred',
    {
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_LOCAL_BINARY_BYTES + 1,
      path: '/d/big.pdf',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  [
    'local pdf at the old 50 MiB vision cap',
    {
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: 50 * 1024 * 1024,
      path: '/d/big.pdf',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  [
    'local pdf just over the old 50 MiB vision cap',
    {
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: 50 * 1024 * 1024 + 1,
      path: '/d/big.pdf',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  // Local audio is extension-gated, exactly like isTranscribableExt. A blanket
  // video/* allow would admit these two and produce permanent empty rows.
  [
    'local avi is not transcribable',
    {
      profile: 'local-folder',
      filename: 'clip.avi',
      mime: 'video/x-msvideo',
      sizeBytes: 100,
      path: '/d/clip.avi',
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'local webm stays denied even with an audio mime',
    {
      profile: 'local-folder',
      filename: 'voice.webm',
      mime: 'audio/webm',
      sizeBytes: 100,
      path: '/d/voice.webm',
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'local 3gp',
    {
      profile: 'local-folder',
      filename: 'v.3gp',
      mime: 'video/3gpp',
      sizeBytes: 100,
      path: '/d/v.3gp',
    },
    { kind: 'index', pipeline: 'audio', bytes: 'eager' },
  ],
  // Local images are VISUAL_EXTS membership (isIngestible); cloud is image/*
  // (isConvertibleMime). SVG separates the two.
  [
    'local svg',
    {
      profile: 'local-folder',
      filename: 'logo.svg',
      mime: 'image/svg+xml',
      sizeBytes: 100,
      path: '/d/logo.svg',
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'cloud svg',
    {
      profile: 'cloud-drive',
      filename: 'logo.svg',
      mime: 'image/svg+xml',
      sizeBytes: 100,
    },
    { kind: 'index', pipeline: 'vision', bytes: 'eager' },
  ],
  // Email: both profiles convert it; .msg and cloud .eml since policy v2.
  // Legacy Excel stays local-only.
  [
    'local eml',
    {
      profile: 'local-folder',
      filename: 'm.eml',
      mime: 'message/rfc822',
      sizeBytes: 100,
      path: '/d/m.eml',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud eml',
    {
      profile: 'cloud-drive',
      filename: 'm.eml',
      mime: 'message/rfc822',
      sizeBytes: 100,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'local xls',
    {
      profile: 'local-folder',
      filename: 'b.xls',
      mime: 'application/vnd.ms-excel',
      sizeBytes: 100,
      path: '/d/b.xls',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud xls',
    {
      profile: 'cloud-drive',
      filename: 'b.xls',
      mime: 'application/vnd.ms-excel',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'cloud docx',
    {
      profile: 'cloud-drive',
      filename: 'c.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 100,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud jar',
    {
      profile: 'cloud-drive',
      filename: 'lib.jar',
      mime: 'application/java-archive',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'archive' },
  ],
];

describe.each(cases)('%s', (_name, input, expected) => {
  it('returns the exact policy decision', () => {
    expect(decideFileIndexing(input)).toEqual(expected);
  });
});

// Every archive extension and exact MIME from the spec, on both profiles —
// archives are denied "at every size, on both profiles" (policy step 3).
const ARCHIVE_EXTENSIONS = [
  'zip',
  'tar',
  'tgz',
  'gz',
  'bz2',
  'xz',
  'zst',
  '7z',
  'rar',
  'cab',
  'iso',
  'dmg',
  'img',
  'vhd',
  'vhdx',
  'ova',
  'war',
  'jar',
  'apk',
  'ipa',
];
const ARCHIVE_MIMES = [
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/x-iso9660-image',
  'application/vnd.android.package-archive',
  'application/java-archive',
];

describe('archives are denied on both profiles, at every extension and mime', () => {
  for (const profile of ['local-folder', 'cloud-drive'] as const) {
    for (const ext of ARCHIVE_EXTENSIONS) {
      it(`${profile}: .${ext} by extension`, () => {
        expect(
          decideFileIndexing({
            profile,
            filename: `payload.${ext}`,
            mime: 'application/octet-stream',
            sizeBytes: 1,
            path: `/d/payload.${ext}`,
          }),
        ).toEqual({ kind: 'ignore', reason: 'archive' });
      });
    }
    for (const mime of ARCHIVE_MIMES) {
      it(`${profile}: ${mime} by mime`, () => {
        expect(
          decideFileIndexing({
            profile,
            filename: 'payload.bin',
            mime,
            sizeBytes: 1,
            path: '/d/payload.bin',
          }),
        ).toEqual({ kind: 'ignore', reason: 'archive' });
      });
    }
  }
});

describe('mime parameters and malformed sizes', () => {
  it('strips mime parameters before matching (cloud audio with codecs)', () => {
    expect(
      decideFileIndexing({
        profile: 'cloud-drive',
        filename: 'song.mp3',
        mime: 'audio/mpeg; codecs=x',
        sizeBytes: 100,
      }),
    ).toEqual({ kind: 'ignore', reason: 'cloud-media' });
  });

  it('strips mime parameters before matching (local mp3 with codecs)', () => {
    expect(
      decideFileIndexing({
        profile: 'local-folder',
        filename: 'meeting.mp3',
        mime: 'audio/mpeg; codecs=x',
        sizeBytes: 100,
        path: '/d/meeting.mp3',
      }),
    ).toEqual({ kind: 'index', pipeline: 'audio', bytes: 'eager' });
  });

  it.each([-1, -1024, NaN, Infinity, -Infinity])(
    'treats a negative or non-finite size (%p) as unknown, not "too large"',
    (sizeBytes) => {
      expect(
        decideFileIndexing({
          profile: 'cloud-drive',
          filename: 'a.pdf',
          mime: 'application/pdf',
          sizeBytes,
        }),
      ).toEqual({ kind: 'index', pipeline: 'converter', bytes: 'eager' });
    },
  );
});

// The `isIngestible`-equivalence describe block that lived here (added in
// Task 1) has been DELETED, not kept as a smoke test. Its purpose was
// guarding Task 1's verbatim move of the local-folder rules into this shared
// module, by asserting decideFileIndexing's `kind` agreed with the OLD,
// independently-implemented `isIngestible`. Task 2 (this change) makes
// `isIngestible` itself delegate to `decideFileIndexing` (see
// `local-folder/ingestible.ts`'s `decideLocalFile`), so the block would now
// assert `f(x) === f(x)` for every extension — a tautology that can never
// fail, which is worse than no test at all. The real regression coverage for
// local-folder eligibility now lives in `local-folder/__tests__/*.test.ts`,
// which exercises `decideLocalFile`/`isIngestible` against real files.

const more: Case[] = [
  [
    'cloud pdf just over eager cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_CLOUD_BINARY_BYTES + 1,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  [
    'cloud pdf at fetch cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_FETCH_BYTES,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  [
    'cloud pdf over fetch cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_FETCH_BYTES + 1,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'none' },
  ],
  [
    'local pdf 30 MiB',
    { profile: 'local-folder', filename: 'a.pdf', sizeBytes: 30 * 1024 * 1024 },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' },
  ],
  [
    'local pdf 150 MiB',
    {
      profile: 'local-folder',
      filename: 'a.pdf',
      sizeBytes: 150 * 1024 * 1024,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'none' },
  ],
  [
    'cloud docx over eager cap',
    {
      profile: 'cloud-drive',
      filename: 'a.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: MAX_CLOUD_BINARY_BYTES + 1,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'none' },
  ],
  [
    'local docx over eager cap',
    {
      profile: 'local-folder',
      filename: 'a.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: MAX_LOCAL_BINARY_BYTES + 1,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'none' },
  ],
  [
    'local text over inline cap',
    {
      profile: 'local-folder',
      filename: 'a.log',
      sizeBytes: MAX_LOCAL_TEXT_BYTES + 1,
    },
    { kind: 'index', pipeline: 'inline-text', bytes: 'none' },
  ],
  [
    'cloud image over cap stays ignored',
    {
      profile: 'cloud-drive',
      filename: 'a.png',
      mime: 'image/png',
      sizeBytes: 30 * 1024 * 1024,
    },
    { kind: 'ignore', reason: 'too-large' },
  ],
  [
    'local audio over cap stays ignored',
    {
      profile: 'local-folder',
      filename: 'a.mp3',
      sizeBytes: MAX_LOCAL_AUDIO_BYTES + 1,
    },
    { kind: 'ignore', reason: 'too-large' },
  ],
];
it.each(more)('%s', (_n, c, want) =>
  expect(decideFileIndexing(c)).toEqual(want),
);

describe('newlyAdmitted', () => {
  // The local source always passes the path-derived MIME (decideLocalFile).
  const local = (filename: string, sizeBytes: number, mime?: string) => ({
    profile: 'local-folder' as const,
    filename,
    sizeBytes,
    mime,
    path: `/r/${filename}`,
  });
  it('a version-1 cursor re-emits deferred and none rows', () => {
    expect(newlyAdmitted(local('a.pdf', 60 * 1024 * 1024), 1)).toBe(true);
    expect(
      newlyAdmitted(
        local(
          'a.docx',
          30 * 1024 * 1024,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
        1,
      ),
    ).toBe(true);
  });
  it('a version-1 cursor does NOT re-emit eager files', () => {
    expect(newlyAdmitted(local('a.pdf', 1024), 1)).toBe(false);
    expect(newlyAdmitted(local('notes.txt', 10), 1)).toBe(false);
  });
  it('never re-emits ignored files', () => {
    expect(newlyAdmitted(local('a.zip', 10), 1)).toBe(false);
  });
  it('is false once the cursor is current', () => {
    expect(
      newlyAdmitted(local('a.pdf', 60 * 1024 * 1024), FILE_POLICY_VERSION),
    ).toBe(false);
  });
});

const msgCases: Case[] = [
  [
    'local msg',
    {
      profile: 'local-folder',
      filename: 'm.msg',
      mime: 'application/vnd.ms-outlook',
      sizeBytes: 100,
      path: '/d/m.msg',
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud msg (outlook mime)',
    {
      profile: 'cloud-drive',
      filename: 'm.msg',
      mime: 'application/vnd.ms-outlook',
      sizeBytes: 100,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud msg (octet-stream, ext rescue)',
    {
      profile: 'cloud-drive',
      filename: 'm.msg',
      mime: 'application/octet-stream',
      sizeBytes: 100,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud eml (octet-stream, ext rescue)',
    {
      profile: 'cloud-drive',
      filename: 'm.eml',
      mime: 'application/octet-stream',
      sizeBytes: 100,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud msg (no mime, ext rescue)',
    { profile: 'cloud-drive', filename: 'm.msg', sizeBytes: 100 },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' },
  ],
  [
    'cloud octet-stream without msg/eml ext stays unsupported',
    {
      profile: 'cloud-drive',
      filename: 'blob',
      mime: 'application/octet-stream',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'unsupported' },
  ],
  [
    'cloud msg over eager cap → none',
    {
      profile: 'cloud-drive',
      filename: 'm.msg',
      mime: 'application/vnd.ms-outlook',
      sizeBytes: MAX_CLOUD_BINARY_BYTES + 1,
    },
    { kind: 'index', pipeline: 'converter', bytes: 'none' },
  ],
];
it.each(msgCases)('%s', (_n, c, want) =>
  expect(decideFileIndexing(c)).toEqual(want),
);

it('newlyAdmitted re-emits an eager local .msg for a version-1 cursor only', () => {
  const c = {
    profile: 'local-folder' as const,
    filename: 'm.msg',
    mime: 'application/vnd.ms-outlook',
    sizeBytes: 100,
    path: '/d/m.msg',
  };
  expect(newlyAdmitted(c, 1)).toBe(true);
  expect(newlyAdmitted(c, FILE_POLICY_VERSION)).toBe(false);
  // local eml was always admitted
  expect(
    newlyAdmitted(
      { ...c, filename: 'm.eml', mime: 'message/rfc822', path: '/d/m.eml' },
      1,
    ),
  ).toBe(false);
});
