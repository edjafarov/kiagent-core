import type { Document } from '@shared/contracts';

import { audioExt, classifyAudio, isAudioDoc } from '../classify';

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

describe('classifyAudio', () => {
  it('accepts an attachment with an audio/* mime (gmail/extension attachments)', () => {
    expect(
      classifyAudio(
        doc({ metadata: { mime: 'audio/mp4', filename: 'vn.m4a' } }),
      ),
    ).toBe('candidate');
    expect(
      classifyAudio(
        doc({ metadata: { mime: 'audio/ogg', filename: 'note.ogg' } }),
      ),
    ).toBe('candidate');
  });

  it('accepts a local-folder file by extension when no mime is present', () => {
    // local-folder stamps `metadata.ext` (no dot) and NO mime.
    expect(
      classifyAudio(
        doc({ type: 'file', title: 'memo.mp3', metadata: { ext: 'mp3' } }),
      ),
    ).toBe('candidate');
    expect(
      classifyAudio(
        doc({ type: 'file', title: 'voice.opus', metadata: { ext: 'opus' } }),
      ),
    ).toBe('candidate');
  });

  it('skips non-audio documents (images, pdfs, plain files)', () => {
    expect(
      classifyAudio(
        doc({ metadata: { mime: 'image/png', filename: 'a.png' } }),
      ),
    ).toBe('skip');
    expect(
      classifyAudio(
        doc({ metadata: { mime: 'application/pdf', filename: 'a.pdf' } }),
      ),
    ).toBe('skip');
    expect(
      classifyAudio(
        doc({ type: 'file', title: 'notes.txt', metadata: { ext: 'txt' } }),
      ),
    ).toBe('skip');
  });

  it('does not treat .webm/.mkv (usually video) as audio unless the mime says so', () => {
    expect(
      classifyAudio(
        doc({ type: 'file', title: 'clip.webm', metadata: { ext: 'webm' } }),
      ),
    ).toBe('skip');
    // An audio-only webm with an explicit audio mime still matches.
    expect(
      classifyAudio(
        doc({ metadata: { mime: 'audio/webm', filename: 'a.webm' } }),
      ),
    ).toBe('candidate');
  });

  it('skips already-extracted docs (the extraction marker guards re-entrancy)', () => {
    expect(
      classifyAudio(
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
      classifyAudio(
        doc({ metadata: { mime: 'audio/mpeg' }, archivedAt: '2026-01-01' }),
      ),
    ).toBe('skip');
    expect(
      classifyAudio(
        doc({ type: 'email.message', metadata: { mime: 'audio/mpeg' } }),
      ),
    ).toBe('skip');
  });
});

describe('isAudioDoc / audioExt', () => {
  it('detects audio by mime OR extension', () => {
    expect(isAudioDoc(doc({ metadata: { mime: 'audio/flac' } }))).toBe(true);
    expect(
      isAudioDoc(
        doc({ type: 'file', title: 'x.wav', metadata: { ext: 'wav' } }),
      ),
    ).toBe(true);
    expect(
      isAudioDoc(doc({ metadata: { mime: 'text/plain' }, title: 'x.txt' })),
    ).toBe(false);
  });

  it('audioExt prefers metadata.ext, falls back to the filename/title', () => {
    expect(audioExt(doc({ metadata: { ext: 'M4A' } }))).toBe('m4a');
    expect(audioExt(doc({ metadata: { filename: 'song.OGG' } }))).toBe('ogg');
    expect(audioExt(doc({ title: 'no-extension', metadata: {} }))).toBe('');
  });
});
