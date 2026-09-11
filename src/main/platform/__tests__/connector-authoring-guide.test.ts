/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

describe('connector authoring guide', () => {
  it('documents inference lane defaults and caller-supplied overrides', () => {
    const guide = fs.readFileSync(
      path.join(__dirname, '../../../../docs/connectors-authoring-guide.md'),
      'utf8',
    );
    expect(guide).toContain(
      "`inference` calls default to the `'interactive'` lane",
    );
    expect(guide).toContain('caller-supplied `lane` option');
    expect(guide).not.toContain(
      "inference calls are **forced onto the 'interactive' lane**",
    );
  });
});
