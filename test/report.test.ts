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
  const makeOctokit = (comments: Array<{ id: number; body: string }>) => {
    const createComment = vi.fn(async () => ({}));
    const updateComment = vi.fn(async () => ({}));
    return {
      createComment,
      updateComment,
      octokit: {
        rest: { issues: { listComments: vi.fn(), createComment, updateComment } },
        paginate: vi.fn(async () => comments),
      } as never,
    };
  };

  it('updates an existing marked comment', async () => {
    const { octokit, updateComment, createComment } = makeOctokit([
      { id: 1, body: 'unrelated' },
      { id: 2, body: `${COMMENT_MARKER}\nold` },
    ]);
    await upsertComment(octokit, target, 'new');

    expect(updateComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 2, body: 'new' });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('creates a comment when none is marked', async () => {
    const { octokit, updateComment, createComment } = makeOctokit([{ id: 1, body: 'unrelated' }]);
    await upsertComment(octokit, target, 'new');

    expect(createComment).toHaveBeenCalledWith({ ...target, body: 'new' });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('warns instead of throwing on 403', async () => {
    const { octokit, createComment } = makeOctokit([]);
    createComment.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { status: 403 }));

    await expect(upsertComment(octokit, target, 'new')).resolves.toBeUndefined();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('pull-requests: write'));
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
