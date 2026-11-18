import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FontResult } from '../src/check';
import { annotate, COMMENT_MARKER, markdownReport, summarize, upsertComment } from '../src/report';

vi.mock('@actions/core');

const ok = (file: string, band: string, score: number): FontResult => ({
  file,
  ok: true,
  inspection: {
    id: 'i',
    status: 'succeeded',
    score,
    band,
    counts: { error: 1, warning: 2, info: 3, pass: 4 },
    findings: [
      { code: 'a', severity: 'error', category: 'x', title: 'Missing name table' },
      { code: 'b', severity: 'warning', category: 'x', title: 'Odd weight' },
      { code: 'c', severity: 'info', category: 'x', title: 'Has kerning' },
    ],
    report_url: `https://everythingfonts.com/r/${score}`,
  },
});

const decision = { failed: false, reasons: [] };

beforeEach(() => vi.clearAllMocks());

describe('markdownReport', () => {
  it('has the marker, each file, score, band emoji, link and footer', () => {
    const md = markdownReport([ok('a.ttf', 'healthy', 91), ok('b.otf', 'unhealthy', 30)], decision, {
      allowance: { limit: 100, used: 40, remaining: 60, resetsAt: '' },
    });

    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain('a.ttf');
    expect(md).toContain('91');
    expect(md).toContain('✅');
    expect(md).toContain('❌');
    expect(md).toContain('(https://everythingfonts.com/r/91)');
    expect(md).toContain('error: Missing name table');
    expect(md).toContain('Full report, every finding and one-click fixes: [everythingfonts.com]');
    expect(md).toContain('60 of 100 free checks left this month');
  });

  it('omits the allowance line when unknown and shows refused fonts', () => {
    const md = markdownReport([{ file: 'big.ttf', ok: false, error: 'Too large' }], { failed: true, reasons: ['big.ttf: Too large'] });

    expect(md).not.toContain('free checks left');
    expect(md).toContain('Too large');
    expect(md).toContain('Result: failed');
  });
});

describe('summarize', () => {
  it('maps results to the output shape', () => {
    const [good, bad] = summarize([ok('a.ttf', 'healthy', 91), { file: 'b.ttf', ok: false, error: 'nope' }]);

    expect(good).toEqual({
      file: 'a.ttf',
      score: 91,
      band: 'healthy',
      counts: { error: 1, warning: 2, info: 3, pass: 4 },
      report_url: 'https://everythingfonts.com/r/91',
    });
    expect(bad).toMatchObject({ file: 'b.ttf', score: null, error: 'nope' });
  });
});

describe('upsertComment', () => {
  const target = { owner: 'o', repo: 'r', issue_number: 7 };
  type C = { id: number; body: string; user: { type: string } };
  const bot = (id: number, body: string): C => ({ id, body, user: { type: 'Bot' } });
  const makeOctokit = (pages: C[][]) => {
    const createComment = vi.fn(async () => ({}));
    const updateComment = vi.fn(async () => ({}));
    const listComments = vi.fn(async ({ page }: { page: number }) => ({ data: pages[page - 1] ?? [] }));
    return { createComment, updateComment, listComments, octokit: { rest: { issues: { listComments, createComment, updateComment } } } as never };
  };

  it('updates an existing bot-authored marked comment', async () => {
    const { octokit, updateComment, createComment } = makeOctokit([[bot(1, 'unrelated'), bot(2, `${COMMENT_MARKER}\nold`), bot(3, `${COMMENT_MARKER}`)]]);
    await upsertComment(octokit, target, 'new');

    expect(updateComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 2, body: 'new' });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('ignores a marker comment written by a human and creates its own', async () => {
    const { octokit, updateComment, createComment } = makeOctokit([[{ id: 1, body: COMMENT_MARKER, user: { type: 'User' } }]]);
    await upsertComment(octokit, target, 'new');

    expect(createComment).toHaveBeenCalledWith({ ...target, body: 'new' });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('finds the comment on a later page', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => bot(i + 10, 'x'));
    const { octokit, updateComment, listComments } = makeOctokit([filler, [bot(500, COMMENT_MARKER)]]);
    await upsertComment(octokit, target, 'new');

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 500 }));
  });

  it.each([403, 404, 422, 500])('warns instead of throwing on %i', async (status) => {
    const { octokit, createComment } = makeOctokit([]);
    createComment.mockRejectedValueOnce(Object.assign(new Error('secret detail'), { status }));

    await expect(upsertComment(octokit, target, 'new')).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.not.stringContaining('secret detail'));
  });

  it('warns instead of throwing when updating fails', async () => {
    const { octokit, updateComment } = makeOctokit([[bot(2, COMMENT_MARKER)]]);
    updateComment.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));

    await expect(upsertComment(octokit, target, 'new')).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalled();
  });

  it('warns when listing fails', async () => {
    const { octokit, listComments } = makeOctokit([]);
    listComments.mockRejectedValueOnce(new Error('boom'));

    await expect(upsertComment(octokit, target, 'new')).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalled();
  });
});

describe('markdown safety', () => {
  it('neutralises hostile file names, titles and urls', () => {
    const hostile: FontResult = {
      file: 'a|b`c\n@user.ttf',
      ok: true,
      inspection: {
        id: 'i',
        status: 'succeeded',
        score: 50,
        band: 'needs-attention',
        counts: { error: 1, warning: 0, info: 0, pass: 0 },
        findings: [{ code: 'x', severity: 'error', category: 'c', title: '[x](http://evil) @user <img src=x> | **b**' }],
        report_url: 'javascript:alert(1)',
      },
    };
    const insecure = ok('b.ttf', 'healthy', 90);
    if (insecure.ok) {
      insecure.inspection.report_url = 'http://insecure.test/r';
    }
    const md = markdownReport([hostile, insecure], {
      failed: true,
      reasons: ['a|b`c\n@user.ttf: 1 error'],
    });

    expect(md).not.toContain('](http://evil)');
    expect(md).toContain('\\[x\\]\\(http://evil\\)');
    expect(md).not.toMatch(/@user/);
    expect(md).not.toMatch(/(?<!\\)<img/);
    expect(md).toContain('`a\\|b c @\u200Duser.ttf`');
    expect(md).not.toContain('javascript:');
    expect(md).not.toContain('http://insecure.test');
    expect(md).not.toContain('[full report]');
  });

  it('encodes parentheses in an https report url', () => {
    const md = markdownReport([{ ...ok('a.ttf', 'healthy', 90) }].map((r) => ({ ...r, inspection: { ...(r as never as { inspection: object }).inspection, report_url: 'https://e.test/r(1)' } })) as never, decision);
    expect(md).toContain('(https://e.test/r%281%29)');
  });

  it('caps the body at a line boundary and keeps marker and footer', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ok(`font-${i}.ttf`, 'healthy', 90));
    const md = markdownReport(many, decision);

    expect(md.length).toBeLessThanOrEqual(60000);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toMatch(/… \d+ more fonts not shown — see the job log/);
    expect(md).toContain('everythingfonts.com');
    expect(md.endsWith('\n')).toBe(true);
  });
});

describe('reason cap', () => {
  it('trims reasons and fonts so 3000 failures stay under the cap', () => {
    const many: FontResult[] = Array.from({ length: 3000 }, (_, i) => ({ file: `font-${i}.ttf`, ok: false, error: 'bad file' }));
    const reasons = many.map((r) => `${r.file}: bad file`);
    const md = markdownReport(many, { failed: true, reasons });

    expect(md.length).toBeLessThanOrEqual(60000);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain('everythingfonts.com');
    expect(md).toContain('\u2026 and 2980 more \u2014 see the job log');
    expect(md).toMatch(/\u2026 \d+ more fonts not shown \u2014 see the job log/);
    expect(md.split('\n').filter((l) => l.startsWith('- font-')).length).toBe(20);
  });
});

describe('annotate caps', () => {
  it('emits at most 10 per severity then one notice', () => {
    const many: FontResult[] = Array.from({ length: 15 }, (_, i) => ok(`f${i}.ttf`, 'unhealthy', 10));
    annotate(many);

    expect(core.error).toHaveBeenCalledTimes(10);
    expect(core.warning).toHaveBeenCalledTimes(10);
    expect(core.notice).toHaveBeenCalledWith('15 more findings \u2014 see the job summary');
  });
});

describe('annotate', () => {
  it('emits a call per finding and for refused and quota fonts', () => {
    annotate([
      ok('a.ttf', 'unhealthy', 30),
      { file: 'b.ttf', ok: false, error: 'Too large' },
      { file: 'c.ttf', ok: false, error: 'Skipped: API allowance used up.', quota: true, skipped: 'quota' },
    ]);

    expect(core.error).toHaveBeenCalledWith('Missing name table', { file: 'a.ttf' });
    expect(core.warning).toHaveBeenCalledWith('Odd weight', { file: 'a.ttf' });
    expect(core.notice).toHaveBeenCalledWith('Has kerning', { file: 'a.ttf' });
    expect(core.error).toHaveBeenCalledWith('b.ttf: Too large', { file: 'b.ttf' });
    expect(core.warning).toHaveBeenCalledWith('c.ttf: Skipped: API allowance used up.', { file: 'c.ttf' });
  });
});
