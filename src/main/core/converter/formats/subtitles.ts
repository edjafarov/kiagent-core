/** SRT/VTT → a readable transcript: one paragraph per minute, prefixed
 *  `[mm:00]` (minutes may exceed 59); cue numbers, timings, settings and tags
 *  dropped; consecutive duplicate cues (rolling captions) collapsed. Pure. */
const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
  quot: '"',
  apos: "'",
};

const seconds = (t: string): number =>
  t
    .replace(',', '.')
    .split(':')
    .map(Number)
    .reduce((acc, p) => acc * 60 + p, 0);

const clean = (line: string): string =>
  line
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|nbsp|quot|apos);/g, (_, e: string) => ENTITIES[e])
    .trim();

export function subtitlesToMarkdown(text: string): string {
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/);
  const minutes = new Map<number, string[]>();
  let last = '';
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => TIMING.test(l));
    if (at < 0) continue; // WEBVTT header, NOTE, STYLE, REGION
    const minute = Math.floor(seconds(TIMING.exec(lines[at])![1]) / 60);
    const cue = lines
      .slice(at + 1)
      .map(clean)
      .filter(Boolean)
      .join(' ');
    if (!cue || cue === last) continue;
    last = cue;
    const list = minutes.get(minute) ?? [];
    list.push(cue);
    minutes.set(minute, list);
  }
  return [...minutes.entries()]
    .sort(([a], [b]) => a - b)
    .map(([m, cues]) => `[${String(m).padStart(2, '0')}:00] ${cues.join(' ')}`)
    .join('\n\n');
}
