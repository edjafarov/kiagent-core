import type { Document } from '@shared/contracts';

import {
  audioExt,
  classifyTranscribable,
  isTranscribableDoc,
  MAX_SOURCE_BYTES,
} from '../classify';

function doc(over: Partial<Document> = {}): Document {
  return {
    id: 'd',
    accountId: 'a',
    externalId: 'x',
    type: 'attachment',
    title: 'clip.m4a',
    markdown: null,
    metadata: {},
    createdAt: null,
    parentId: null,
    contentHash: 'h',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as Document;
}

describe('classifyTranscribable', () => {
  it('accepts an attachment with an audio/* mime (gmail/extension attachments)', () => {
    expect(
      classifyTranscribable(
        doc({ metadata: { mime: 'audio/mp4', filename: 'vn.m4a' } }),
      ),
    ).toBe('candidate');
    expect(
      classifyTranscribable(
        doc({ metadata: { mime: 'audio/ogg', filename: 'note.ogg' } }),
      ),
    ).toBe('candidate');
  });

  it('accepts a local-folder file by extension when no mime is present', () => {
    // local-folder stamps `metadata.ext` (no dot) and NO mime.
    expect(
      classifyTranscribable(
        doc({ type: 'file', title: 'memo.mp3', metadata: { ext: 'mp3' } }),
      ),
    ).toBe('candidate');
    expect(
      classifyTranscribable(
        doc({ type: 'file', title: 'voice.opus', metadata: { ext: 'opus' } }),
      ),
    ).toBe('candidate');
  });

  it('skips non-audio documents (images, pdfs, plain files)', () => {
    expect(
      classifyTranscribable(
        doc({ metadata: { mime: 'image/png', filename: 'a.png' } }),
      ),
    ).toBe('skip');
    expect(
      classifyTranscribable(
        doc({ metadata: { mime: 'application/pdf', filename: 'a.pdf' } }),
      ),
    ).toBe('skip');
    expect(
      classifyTranscribable(
        doc({ type: 'file', title: 'notes.txt', metadata: { ext: 'txt' } }),
      ),
    ).toBe('skip');
  });

  it('does not treat .webm/.mkv (usually video) as audio unless the mime says so', () => {
    expect(
      classifyTranscribable(
        doc({ type: 'file', title: 'clip.webm', metadata: { ext: 'webm' } }),
      ),
    ).toBe('skip');
    // An audio-only webm with an explicit audio mime still matches.
    expect(
      classifyTranscribable(
        doc({ metadata: { mime: 'audio/webm', filename: 'a.webm' } }),
      ),
    ).toBe('candidate');
  });

  it('skips already-extracted docs (the extraction marker guards re-entrancy)', () => {
    expect(
      classifyTranscribable(
        doc({
          metadata: {
            mime: 'audio/mpeg',
            filename: 'a.mp3',
            extraction: { engine: 'local-asr', at: '2026-01-01' },
          },
        }),
      ),
    ).toBe('skip');
  });

  it('skips archived docs and non-file/attachment types', () => {
    expect(
      classifyTranscribable(
        doc({ metadata: { mime: 'audio/mpeg' }, archivedAt: '2026-01-01' }),
      ),
    ).toBe('skip');
    expect(
      classifyTranscribable(
        doc({ type: 'email.message', metadata: { mime: 'audio/mpeg' } }),
      ),
    ).toBe('skip');
  });
});

describe('isTranscribableDoc / audioExt', () => {
  it('detects audio by mime OR extension', () => {
    expect(isTranscribableDoc(doc({ metadata: { mime: 'audio/flac' } }))).toBe(
      true,
    );
    expect(
      isTranscribableDoc(
        doc({ type: 'file', title: 'x.wav', metadata: { ext: 'wav' } }),
      ),
    ).toBe(true);
    expect(
      isTranscribableDoc(
        doc({ metadata: { mime: 'text/plain' }, title: 'x.txt' }),
      ),
    ).toBe(false);
  });

  it('audioExt prefers metadata.ext, falls back to the filename/title', () => {
    expect(audioExt(doc({ metadata: { ext: 'M4A' } }))).toBe('m4a');
    expect(audioExt(doc({ metadata: { filename: 'song.OGG' } }))).toBe('ogg');
    expect(audioExt(doc({ title: 'no-extension', metadata: {} }))).toBe('');
  });

  it('audioExt ALLOWLISTS metadata.ext — a traversal ext never reaches a path', () => {
    // metadata is Record<string, unknown> filled by third-party connectors;
    // this value is interpolated into a temp-file name by the transcoder, so
    // anything outside [a-z0-9]{1,8} must come back empty (the transcoder then
    // falls back to its mime map).
    expect(
      audioExt(doc({ metadata: { ext: '../../../../Users/u/target' } })),
    ).toBe('');
    expect(audioExt(doc({ metadata: { ext: '/etc/passwd' } }))).toBe('');
    expect(audioExt(doc({ metadata: { ext: 'm4a/../x' } }))).toBe('');
    expect(audioExt(doc({ metadata: { ext: 'wav wav' } }))).toBe('');
    expect(audioExt(doc({ metadata: { ext: 'verylongext' } }))).toBe('');
    expect(audioExt(doc({ metadata: { ext: '.MP3' } }))).toBe('mp3'); // still normalized
  });

  it('a traversal ext still classifies on the mime (the allowlist does not break the gate)', () => {
    expect(
      classifyTranscribable(
        doc({
          metadata: { mime: 'audio/mpeg', ext: '../../../../tmp/pwn' },
        }),
      ),
    ).toBe('candidate');
    // …and with no mime to fall back on, an unusable ext is simply not audio.
    expect(
      classifyTranscribable(
        doc({ type: 'file', title: 'x', metadata: { ext: '../../x' } }),
      ),
    ).toBe('skip');
  });
});

const tdoc = (meta: Record<string, unknown>, title = 'x'): Document =>
  doc({ title, metadata: meta });

describe('classifyTranscribable — video widening (4-step order)', () => {
  // step 4: video mimes and extensions are candidates
  it.each(['video/mp4', 'video/quicktime', 'video/x-m4v'])(
    'allows %s mime',
    (mime) => {
      expect(classifyTranscribable(tdoc({ mime }))).toBe('candidate');
    },
  );
  it.each(['clip.mp4', 'clip.m4v', 'clip.mov'])(
    'allows extension %s (no mime)',
    (filename) => {
      expect(classifyTranscribable(tdoc({ filename }))).toBe('candidate');
    },
  );

  // step 1: undemuxable video containers denied even filename-less
  it.each(['video/webm', 'video/x-matroska'])(
    'denies %s mime with no filename',
    (mime) => {
      expect(classifyTranscribable(tdoc({ mime }, ''))).toBe('skip');
    },
  );

  // step 2 beats step 3: audio-webm with a .webm filename is STILL accepted
  it('audio/webm mime with a .webm filename stays a candidate (current behaviour preserved)', () => {
    expect(
      classifyTranscribable(
        tdoc({ mime: 'audio/webm', filename: 'note.webm' }),
      ),
    ).toBe('candidate');
  });

  // step 3: no-mime local-folder files with denied extensions
  it.each(['movie.mkv', 'movie.webm'])('denies no-mime %s', (filename) => {
    expect(classifyTranscribable(tdoc({ filename }))).toBe('skip');
  });
  it('denies metadata.ext mkv (local-folder shape)', () => {
    expect(classifyTranscribable(tdoc({ ext: 'mkv' }))).toBe('skip');
  });

  // step 1 beats step 4: video/webm never sneaks in via the video/* allow
  it('video/webm with an innocent filename is denied', () => {
    expect(
      classifyTranscribable(tdoc({ mime: 'video/webm', filename: 'clip.mp4' })),
    ).toBe('skip');
  });

  // step 3 beats step 4: a video/* mime with a denied extension in the
  // filename is still denied — deleting step 3 would let this fall through
  // to step 4's video/* allow.
  it('video/mp4 mime with a .webm filename is denied (step 3 beats step 4)', () => {
    expect(
      classifyTranscribable(tdoc({ mime: 'video/mp4', filename: 'clip.webm' })),
    ).toBe('skip');
  });

  // step 1: mime parameters (Content-Type "; codecs=...") must not bypass
  // the deny list via exact-string matching.
  it('denies video/webm with a codecs parameter', () => {
    expect(classifyTranscribable(tdoc({ mime: 'video/webm;codecs=vp9' }))).toBe(
      'skip',
    );
  });
  it('still allows audio/webm with a codecs parameter (normalization does not break step 2)', () => {
    expect(
      classifyTranscribable(tdoc({ mime: 'audio/webm;codecs=opus' })),
    ).toBe('candidate');
  });
});

describe('classify-time size gate', () => {
  it('rejects sizeBytes over MAX_SOURCE_BYTES before any fetch', () => {
    expect(
      classifyTranscribable(
        tdoc({ mime: 'video/mp4', sizeBytes: MAX_SOURCE_BYTES + 1 }),
      ),
    ).toBe('skip');
  });
  it('accepts exactly MAX_SOURCE_BYTES, and falls back to metadata.size', () => {
    expect(
      classifyTranscribable(
        tdoc({ mime: 'audio/mpeg', sizeBytes: MAX_SOURCE_BYTES }),
      ),
    ).toBe('candidate');
    expect(
      classifyTranscribable(
        tdoc({ mime: 'audio/mpeg', size: MAX_SOURCE_BYTES + 1 }),
      ),
    ).toBe('skip');
  });
  it('no size metadata → still a candidate (post-fetch backstop covers it)', () => {
    expect(classifyTranscribable(tdoc({ mime: 'audio/mpeg' }))).toBe(
      'candidate',
    );
  });
});
