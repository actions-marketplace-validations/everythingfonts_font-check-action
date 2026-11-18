import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { expandBraces, findFonts, splitPatterns } from '../src/fonts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ef-fonts-'));
  mkdirSync(join(root, 'fonts'));
  mkdirSync(join(root, 'other'));
  writeFileSync(join(root, 'fonts', 'A.ttf'), 'x');
  writeFileSync(join(root, 'fonts', 'B.woff2'), 'x');
  writeFileSync(join(root, 'fonts', 'notes.txt'), 'x');
  writeFileSync(join(root, 'other', 'C.ttf'), 'x');
});

describe('splitPatterns', () => {
  it('splits on newlines and on commas outside braces', () => {
    expect(splitPatterns('**/*.{ttf,otf}, fonts/*.woff\n\n  extra/*.ttf ')).toEqual([
      '**/*.{ttf,otf}',
      'fonts/*.woff',
      'extra/*.ttf',
    ]);
  });
});

describe('expandBraces', () => {
  it('expands brace groups, including several and nested ones', () => {
    expect(expandBraces('**/*.{ttf,otf}')).toEqual(['**/*.ttf', '**/*.otf']);
    expect(expandBraces('{a,b}/*.{x,y}')).toEqual(['a/*.x', 'a/*.y', 'b/*.x', 'b/*.y']);
    expect(expandBraces('plain/*.ttf')).toEqual(['plain/*.ttf']);
  });
});

describe('findFonts', () => {
  it('returns the fonts matching the patterns and ignores a .ttf outside them', async () => {
    const files = await findFonts({ patterns: `${root}/fonts/**/*.{ttf,otf,woff,woff2}`, changedOnly: false });

    expect(files).toEqual([join(root, 'fonts', 'A.ttf'), join(root, 'fonts', 'B.woff2')]);
  });

  it('keeps only the changed files when changedOnly is set', async () => {
    const files = await findFonts({
      patterns: `${root}/**/*.ttf`,
      changedOnly: true,
      changedFiles: ['other/C.ttf', 'README.md'],
      workspace: root,
    });

    expect(files).toEqual([join(root, 'other', 'C.ttf')]);
  });

  it('returns nothing when changedOnly is set without changed files', async () => {
    expect(await findFonts({ patterns: `${root}/**/*.ttf`, changedOnly: true, workspace: root })).toEqual([]);
  });
});
