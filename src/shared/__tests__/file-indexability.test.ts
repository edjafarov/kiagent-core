import { isIngestible } from '@main/sources/local-folder/ingestible';

import {
  decideFileIndexing,
  AUDIO_EXTENSIONS,
  LOCAL_TEXT_EXTENSIONS,
  LOCAL_VIDEO_EXTENSIONS,
  MAX_CLOUD_BINARY_BYTES,
  MAX_CLOUD_IMAGE_BYTES,
  MAX_LOCAL_AUDIO_BYTES,
  MAX_LOCAL_BINARY_BYTES,
  MAX_LOCAL_PDF_BYTES,
  MAX_LOCAL_TEXT_BYTES,
  UNDEMUXABLE_EXTENSIONS,
  VISUAL_EXTENSIONS,
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
    { kind: 'index', pipeline: 'converter' },
  ],
  [
    'cloud pdf at cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_CLOUD_BINARY_BYTES,
    },
    { kind: 'index', pipeline: 'converter' },
  ],
  [
    'cloud pdf over cap',
    {
      profile: 'cloud-drive',
      filename: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_CLOUD_BINARY_BYTES + 1,
    },
    { kind: 'ignore', reason: 'too-large' },
  ],
  [
    'cloud image at cap',
    {
      profile: 'cloud-drive',
      filename: 'a.png',
      mime: 'image/png',
      sizeBytes: MAX_CLOUD_IMAGE_BYTES,
    },
    { kind: 'index', pipeline: 'vision' },
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
    { kind: 'index', pipeline: 'converter' },
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
    { kind: 'index', pipeline: 'inline-text' },
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
    { kind: 'ignore', reason: 'too-large' },
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
    { kind: 'index', pipeline: 'converter' },
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
    { kind: 'index', pipeline: 'audio' },
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
    { kind: 'index', pipeline: 'audio' },
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
    'local pdf over converter cap goes to vision',
    {
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_LOCAL_BINARY_BYTES + 1,
      path: '/d/big.pdf',
    },
    { kind: 'index', pipeline: 'vision' },
  ],
  [
    'local pdf at vision cap',
    {
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_LOCAL_PDF_BYTES,
      path: '/d/big.pdf',
    },
    { kind: 'index', pipeline: 'vision' },
  ],
  [
    'local pdf over vision cap',
    {
      profile: 'local-folder',
      filename: 'big.pdf',
      mime: 'application/pdf',
      sizeBytes: MAX_LOCAL_PDF_BYTES + 1,
      path: '/d/big.pdf',
    },
    { kind: 'ignore', reason: 'too-large' },
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
    { kind: 'index', pipeline: 'audio' },
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
    { kind: 'index', pipeline: 'vision' },
  ],
  // Email and legacy Excel: local converts them today, cloud does not. This
  // change narrows; it must not quietly widen the cloud download set.
  [
    'local eml',
    {
      profile: 'local-folder',
      filename: 'm.eml',
      mime: 'message/rfc822',
      sizeBytes: 100,
      path: '/d/m.eml',
    },
    { kind: 'index', pipeline: 'converter' },
  ],
  [
    'cloud eml',
    {
      profile: 'cloud-drive',
      filename: 'm.eml',
      mime: 'message/rfc822',
      sizeBytes: 100,
    },
    { kind: 'ignore', reason: 'unsupported' },
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
    { kind: 'index', pipeline: 'converter' },
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
    { kind: 'index', pipeline: 'converter' },
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
    ).toEqual({ kind: 'index', pipeline: 'audio' });
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
      ).toEqual({ kind: 'index', pipeline: 'converter' });
    },
  );
});

// The real regression net for the whole task: for every extension any
// pipeline currently accepts on the local-folder profile (plus a handful of
// outsiders that must stay rejected), decideFileIndexing's `kind` must agree
// with today's isIngestible. Any disagreement is either a bug in the move or
// a decision that belongs in the spec — there should be none.
describe('agrees with isIngestible for every local-folder extension', () => {
  const extensions = new Set([
    ...AUDIO_EXTENSIONS,
    ...LOCAL_VIDEO_EXTENSIONS,
    ...UNDEMUXABLE_EXTENSIONS,
    ...VISUAL_EXTENSIONS,
    ...LOCAL_TEXT_EXTENSIONS,
    'avi',
    'wmv',
    'mpeg',
    'svg',
    'exe',
    'bin',
    'scache',
  ]);

  for (const ext of extensions) {
    it(`.${ext}`, () => {
      const path = `/d/x.${ext}`;
      const decided =
        decideFileIndexing({
          profile: 'local-folder',
          filename: `x.${ext}`,
          path,
        }).kind === 'index';
      expect(decided).toBe(isIngestible(path));
    });
  }
});
