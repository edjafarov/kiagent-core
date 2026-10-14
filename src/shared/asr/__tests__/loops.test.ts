import {
  findLoopFlags,
  isLoop,
  normaliseTokens,
  removeLoops,
  sentenceRows,
} from '../loops';

describe('normaliseTokens', () => {
  test('NFKC, lower-case, punctuation stripped, apostrophes kept', () => {
    expect(normaliseTokens("Clarity, Clarity! It's ﬁne.")).toEqual([
      'clarity',
      'clarity',
      "it's",
      'fine',
    ]);
    expect(normaliseTokens('')).toEqual([]);
    expect(normaliseTokens('   ...   ')).toEqual([]);
  });
});

describe('isLoop', () => {
  test('a word repeated 6 times is a loop', () => {
    expect(isLoop('clarity clarity clarity clarity clarity clarity')).toBe(
      true,
    );
  });
  test('a 2-gram repeated 3 times covering everything is a loop', () => {
    expect(isLoop('thank you thank you thank you')).toBe(true);
  });
  test('a 4-gram repeated 3 times is a loop', () => {
    expect(isLoop('and so it goes and so it goes and so it goes')).toBe(true);
  });
  test('fewer than 6 tokens is never a loop', () => {
    expect(isLoop('yes yes yes yes yes')).toBe(false);
  });
  test('two repeats are not a loop', () => {
    expect(isLoop('so like this clarity clarity they have their own bot')).toBe(
      false,
    );
  });
  test('a run below 60 % coverage is not a loop', () => {
    expect(
      isLoop('we said no no no but then we decided to ship it anyway today'),
    ).toBe(false);
  });
  test('natural text is not a loop', () => {
    expect(
      isLoop('the quick brown fox jumps over the lazy dog again and again'),
    ).toBe(false);
  });
  test('Unicode and case do not matter', () => {
    expect(isLoop('Дякую, дякую, ДЯКУЮ, дякую, дякую, дякую.')).toBe(true);
  });
  test('boundaries: exactly 6 tokens, exactly 3 repeats, exactly 60 % coverage', () => {
    expect(isLoop('no no no no no no')).toBe(true); // 6 tokens, 1-gram ×6
    expect(isLoop('we go we go we go and then')).toBe(true); // 2-gram ×3 = 6 of 8 tokens = 75 %
    expect(isLoop('a b c d e f a b c d e f a b c d e f x y z w')).toBe(false); // 6-gram > LOOP_MAX_NGRAM
    expect(isLoop('no no no no no no x y z w')).toBe(true); // 6 of 10 = exactly 60 %
    expect(isLoop('no no no no no x y z w')).toBe(false); // 5 of 9 < 60 %
  });
});

describe('findLoopFlags', () => {
  const row = (
    startMs: number,
    endMs: number,
    text: string,
    speakerLabel: string | null = null,
  ) => ({
    startMs,
    endMs,
    speaker: 'them' as const,
    speakerLabel,
    text,
  });
  test('flags a loop row on its own', () => {
    const rows = [
      row(0, 3000, 'hello there'),
      row(3000, 7000, 'no no no no no no'),
      row(7000, 9000, 'ok'),
    ];
    expect(findLoopFlags(rows)).toEqual([
      {
        speaker: 'them',
        speakerLabel: null,
        startMs: 3000,
        endMs: 7000,
        rowIndices: [1],
      },
    ]);
  });
  test('three consecutive identical rows of one key become one extent', () => {
    const rows = [
      row(0, 1000, 'thank you.'),
      row(1000, 2000, 'Thank you'),
      row(2000, 3000, 'thank you!'),
      row(3000, 4000, 'bye'),
    ];
    expect(findLoopFlags(rows)).toEqual([
      {
        speaker: 'them',
        speakerLabel: null,
        startMs: 0,
        endMs: 3000,
        rowIndices: [0, 1, 2],
      },
    ]);
  });
  test('identical rows under different labels are separate sequences', () => {
    const rows = [
      row(0, 1000, 'yes', 'S0'),
      row(1000, 2000, 'yes', 'S1'),
      row(2000, 3000, 'yes', 'S0'),
      row(3000, 4000, 'yes', 'S1'),
      row(4000, 5000, 'yes', 'S0'),
    ];
    expect(findLoopFlags(rows)).toEqual([
      {
        speaker: 'them',
        speakerLabel: 'S0',
        startMs: 0,
        endMs: 5000,
        rowIndices: [0, 2, 4],
      },
    ]);
  });
  test('two identical rows are not flagged', () => {
    expect(findLoopFlags([row(0, 1000, 'ok'), row(1000, 2000, 'ok')])).toEqual(
      [],
    );
  });
  test('a loop row inside an identical run is reported once', () => {
    const t = 'no no no no no no';
    const rows = [row(0, 1000, t), row(1000, 2000, t), row(2000, 3000, t)];
    expect(findLoopFlags(rows)).toEqual([
      {
        speaker: 'them',
        speakerLabel: null,
        startMs: 0,
        endMs: 3000,
        rowIndices: [0, 1, 2],
      },
    ]);
  });
  test('deterministic', () => {
    const rows = [
      row(0, 3000, 'a b c d e f'),
      row(3000, 7000, 'no no no no no no'),
    ];
    expect(findLoopFlags(rows)).toEqual(findLoopFlags(rows));
  });
});

// ── core additions: sentence-level cleanup for the file route ──────────────

const CLEAN_DE = [
  'Wir haben sieben Kinder, die geblieben sind und vier Kinder, die alles neu auf vier Wochen angefangen haben.',
  'Das Training kostet 3.5 Euro pro Einheit, z.B. am Dienstag um 17.30 Uhr.',
  'Dr. Müller hat gesagt, dass die Halle bis 2027 ausgebucht ist.',
  'Ja, das ist so.',
  'Die Kinder schwimmen 1.200 Meter in der Woche, also ca. 300 Meter pro Training.',
];
// ~1k words of varied clean speech: 40 rotations of the five lines with a
// counter so no two sentences are identical.
const LONG_CLEAN = Array.from({ length: 40 }, (_, i) =>
  CLEAN_DE.map((s) => `${s} (Runde ${i + 1})`).join(' '),
).join(' ');

describe('sentenceRows', () => {
  test('splits on sentence punctuation + whitespace and on newlines, not inside decimals', () => {
    expect(
      sentenceRows('Es kostet 3.5 Euro. Gut! Wirklich?\nNeu').map(
        (r) => r.text,
      ),
    ).toEqual(['Es kostet 3.5 Euro.', 'Gut!', 'Wirklich?', 'Neu']);
  });
});

describe('sentenceRows — CJK', () => {
  test('splits after 。！？ even with no following space', () => {
    expect(sentenceRows('你好。谢谢！真的？').map((r) => r.text)).toEqual([
      '你好。',
      '谢谢！',
      '真的？',
    ]);
  });
});

describe('removeLoops', () => {
  test('leaves clean text byte-identical and not degenerate', () => {
    const r = removeLoops(LONG_CLEAN);
    expect(r.text).toBe(LONG_CLEAN);
    expect(r.removedTokens).toBe(0);
    expect(r.totalTokens).toBeGreaterThan(900);
    expect(r.degenerate).toBe(false);
  });

  test('keeps one of a short legitimate repeat and stays under the floor', () => {
    const r = removeLoops('Ja. Ja. Ja.');
    expect(r.text).toBe('Ja.');
    expect(r.removedTokens).toBe(2);
    expect(r.degenerate).toBe(false);
  });

  test('flags the Z88 junk as degenerate', () => {
    const junk = `Thank you. ${'I’m. '.repeat(790)}Thank you.`;
    const r = removeLoops(junk);
    expect(r.degenerate).toBe(true);
    expect(r.removedTokens).toBeGreaterThanOrEqual(789);
  });

  test('collapses an applause tail in otherwise clean text and is not degenerate', () => {
    // The counter suffix "(Runde 40)" glues onto the first "Vielen Dank.",
    // so the identical run is the remaining 19: one kept, 18 × 2 dropped.
    const r = removeLoops(`${LONG_CLEAN} ${'Vielen Dank. '.repeat(20)}`.trim());
    expect(r.text).toBe(`${LONG_CLEAN} Vielen Dank. Vielen Dank.`);
    expect(r.removedTokens).toBe(36);
    expect(r.degenerate).toBe(false);
  });

  test('cleans the measured "Und dann ist es so…" chunk-tail loop without calling it degenerate', () => {
    // Shape of the real Z88 chunk-1 tail (no -mc 0): good speech, then the
    // same sentence ×5 to the chunk edge.
    const loop = 'Und dann ist es so, dass wir das machen.';
    const good = CLEAN_DE.join(' ');
    const r = removeLoops(`${good} ${Array(5).fill(loop).join(' ')}`);
    expect(r.text).toBe(`${good} ${loop}`);
    expect(r.removedTokens).toBe(4 * normaliseTokens(loop).length);
    expect(r.degenerate).toBe(false);
  });

  test('drops a sentence that loops inside itself', () => {
    const looped = `Und das ist ${'Klinikentizität '.repeat(12).trim()}.`;
    const r = removeLoops(`${CLEAN_DE[0]} ${looped} ${CLEAN_DE[2]}`);
    expect(r.text).toBe(`${CLEAN_DE[0]} ${CLEAN_DE[2]}`);
    expect(r.degenerate).toBe(false);
  });

  test('drops the kept first sentence of a run when it also loops inside itself', () => {
    const s = `${'der Klinikentizität '.repeat(5).trim()}.`;
    const r = removeLoops(`${CLEAN_DE[0]} ${s} ${s} ${s}`);
    expect(r.text).toBe(CLEAN_DE[0]);
  });

  test('treats text that is empty after cleanup as degenerate', () => {
    const r = removeLoops(`${'Klinik '.repeat(10).trim()}.`);
    expect(r.text).toBe('');
    expect(r.degenerate).toBe(true);
  });
});
