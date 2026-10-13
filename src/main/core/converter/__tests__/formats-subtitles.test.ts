/** @jest-environment node */
import { subtitlesToMarkdown } from '../formats/subtitles';
import { parse } from '../parsers';

describe('subtitles', () => {
  it('srt with BOM and CRLF: cue numbers and timings dropped, minute markers kept', () => {
    const srt =
      '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\nWelcome to the call.\r\n\r\n' +
      '2\r\n00:00:04,000 --> 00:00:06,500\r\nLet us start.\r\n\r\n' +
      '3\r\n00:01:02,000 --> 00:01:04,000\r\nBudget first.\r\n';
    expect(subtitlesToMarkdown(srt)).toBe(
      '[00:00] Welcome to the call. Let us start.\n\n[01:00] Budget first.',
    );
  });

  it('vtt: header, NOTE and STYLE blocks and inline tags removed; repeated lines collapsed', () => {
    const vtt =
      'WEBVTT\n\nNOTE produced by Zoom\n\nSTYLE\n::cue { color: red }\n\n' +
      '00:00:01.000 --> 00:00:02.000\n<v Anna>Hello <b>team</b>\n\n' +
      '00:00:02.000 --> 00:00:03.000\n<v Anna>Hello <b>team</b>\n\n' +
      '1:00:00.000 --> 1:00:01.000 align:start\nOne hour in.\n';
    expect(subtitlesToMarkdown(vtt)).toBe(
      '[00:00] Hello team\n\n[60:00] One hour in.',
    );
  });

  it('vtt short timestamps (mm:ss.ttt) and entities', () => {
    expect(
      subtitlesToMarkdown(
        'WEBVTT\n\n01:05.000 --> 01:07.000\nTom &amp; Jerry\n',
      ),
    ).toBe('[01:00] Tom & Jerry');
  });

  it('parse() dispatches .srt and .vtt', async () => {
    const bytes = new TextEncoder().encode(
      '1\n00:00:01,000 --> 00:00:02,000\nHi\n',
    );
    expect(await parse(bytes, 'application/x-subrip', 'a.srt')).toBe(
      '[00:00] Hi',
    );
    expect(await parse(bytes, 'text/vtt', 'a.vtt')).toBe('[00:00] Hi');
  });
});
