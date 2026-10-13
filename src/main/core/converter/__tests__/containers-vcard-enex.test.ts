/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { expandEnex } from '../containers/enex';
import { expandVcard } from '../containers/vcard';
import { DEFAULT_EXPAND_BUDGET } from '../containers/types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-cards-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, content: string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

describe('expandVcard', () => {
  const VCF = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Weber;Anna;;Dr.;',
    'FN:Dr. Anna Weber',
    'ORG:Grips Intelligence;Research',
    'TITLE:Head of Data',
    'item1.EMAIL;TYPE=INTERNET:anna@example.de',
    'TEL;TYPE=CELL:+49 170 1234567',
    'ADR;TYPE=WORK:;;Hauptstr. 1;München;;80331;Germany',
    'NOTE:Met at the conference\\, very kind.\\nSecond line',
    'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv',
    ' /2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7',
    'UID:urn:uuid:1234',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BC=',
    'ller',
    'EMAIL;PREF:jm@example.com',
    'END:VCARD',
  ].join('\r\n');

  it('one contact.card per card: name, org, title, email, phone, address, note; photo dropped', async () => {
    const r = await expandVcard(
      write('contacts.vcf', VCF),
      null,
      DEFAULT_EXPAND_BUDGET,
    );
    expect(r.items.map((i) => i.title)).toEqual([
      'Dr. Anna Weber',
      'Jürgen Müller',
    ]);
    const [anna, juergen] = r.items;
    expect(anna.type).toBe('contact.card');
    expect(anna.key).toMatch(/^vcf:[0-9a-f]{40}$/);
    expect(anna.markdown).toBe(
      [
        '# Dr. Anna Weber',
        '**Organization:** Grips Intelligence / Research',
        '**Title:** Head of Data',
        '**Email:** anna@example.de',
        '**Phone:** +49 170 1234567',
        '**Address:** Hauptstr. 1, München, 80331, Germany',
        'Met at the conference, very kind.\nSecond line',
      ].join('\n\n'),
    );
    expect(anna.markdown).not.toContain('9j/4AAQ');
    expect(anna.metadata).toMatchObject({
      emails: ['anna@example.de'],
      phones: ['+49 170 1234567'],
      organization: 'Grips Intelligence / Research',
      uid: 'urn:uuid:1234',
    });
    expect(juergen.metadata.emails).toEqual(['jm@example.com']);
    expect(r.resume).toBeNull();
    expect(r.summary).toBe('# contacts.vcf — 2 contacts');
  });

  it('a single card is still a container of one; ids are stable across runs and pages', async () => {
    const p = write('one.vcf', VCF);
    const a = await expandVcard(p, null, {
      ...DEFAULT_EXPAND_BUDGET,
      items: 1,
    });
    expect(a.items).toHaveLength(1);
    const b = await expandVcard(p, a.resume as never, DEFAULT_EXPAND_BUDGET);
    expect(b.items.map((i) => i.title)).toEqual(['Jürgen Müller']);
    const again = await expandVcard(p, null, DEFAULT_EXPAND_BUDGET);
    expect(again.items.map((i) => i.key)).toEqual(
      [...a.items, ...b.items].map((i) => i.key),
    );
    expect(b.summary).toBe('# one.vcf — 2 contacts');
  });
});

describe('expandEnex', () => {
  const note = (title: string, created: string, extra = '') =>
    `<note><title>${title}</title><content><![CDATA[<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note><div>Body of ${title}</div><en-todo checked="true"/>done item<en-media hash="abc" type="image/png"/></en-note>]]></content><created>${created}</created><updated>20240116T090000Z</updated><tag>work</tag><tag>ideas</tag><note-attributes><source-url>https://example.com/x</source-url><author>Anna</author></note-attributes>${extra}</note>\n`;
  const ENEX = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">\n<en-export export-date="20240120T000000Z" application="Evernote">\n${body}</en-export>\n`;

  it('one note child per note with tags, dates, source and resource names', async () => {
    const p = write(
      'notes.enex',
      ENEX(
        note(
          'Plan',
          '20240115T101500Z',
          '<resource><data encoding="base64">iVBORw0KGgo=</data><mime>image/png</mime><resource-attributes><file-name>sketch.png</file-name></resource-attributes></resource>',
        ) + note('Groceries', '20240201T080000Z'),
      ),
    );
    const r = await expandEnex(p, null, DEFAULT_EXPAND_BUDGET);
    expect(r.items.map((i) => i.title)).toEqual(['Plan', 'Groceries']);
    const [plan] = r.items;
    expect(plan.type).toBe('note');
    expect(plan.key).toMatch(/^enex:[0-9a-f]{40}$/);
    expect(plan.createdAt).toBe('2024-01-15T10:15:00.000Z');
    expect(plan.markdown).toContain('# Plan');
    expect(plan.markdown).toContain('**Tags:** work, ideas');
    expect(plan.markdown).toContain('**Source:** https://example.com/x');
    expect(plan.markdown).toContain('Body of Plan');
    expect(plan.markdown).toContain('☑ done item');
    expect(plan.markdown).toContain('**Attachments:** sketch.png');
    expect(plan.markdown).not.toContain('iVBORw0KGgo');
    expect(r.summary).toBe('# notes.enex — 2 notes');
  });

  it('a note over the per-note cap keeps its text and drops resource data', async () => {
    const big = `<resource><data encoding="base64">${'QUJD'.repeat(2_500_000)}</data><resource-attributes><file-name>big.pdf</file-name></resource-attributes></resource>`;
    const p = write(
      'big.enex',
      ENEX(
        note('Huge', '20240115T101500Z', big) +
          note('After', '20240115T111500Z'),
      ),
    );
    const r = await expandEnex(p, null, DEFAULT_EXPAND_BUDGET);
    expect(r.items.map((i) => i.title)).toEqual(['Huge', 'After']);
    expect(r.items[0].metadata.truncated).toBe(true);
    expect(r.items[0].markdown).toContain('Body of Huge');
  });
});
