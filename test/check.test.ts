import { describe, expect, it, vi } from 'vitest';
import { EfApiError, type EfApi, type Inspection } from '../src/api';
import { decide, runChecks, type FontResult } from '../src/check';

const inspection = (score: number, counts: Partial<Inspection['counts']> = {}): Inspection => ({
  id: 'i',
  status: 'succeeded',
  score,
  counts: { error: 0, warning: 0, info: 0, pass: 5, ...counts },
});

const makeApi = (overrides: Partial<Record<'uploadFont' | 'inspect' | 'waitForInspection', unknown>> = {}): EfApi =>
  ({
    uploadFont: vi.fn(async (path: string) => `id:${path}`),
    inspect: vi.fn(async (id: string) => ({ id: `insp:${id}`, status: 'pending', allowance: null })),
    waitForInspection: vi.fn(async () => inspection(90)),
    ...overrides,
  }) as unknown as EfApi;

describe('runChecks', () => {
  it('checks fonts one at a time and returns an ok result for each', async () => {
    const results = await runChecks(makeApi(), ['a.ttf', 'b.ttf'], { timeoutMs: 60000 });

    expect(results).toEqual([
      { file: 'a.ttf', ok: true, inspection: inspection(90) },
      { file: 'b.ttf', ok: true, inspection: inspection(90) },
    ]);
  });

  it('records a 422 refusal and still checks the next font', async () => {
    const uploadFont = vi
      .fn()
      .mockResolvedValueOnce('f1')
      .mockRejectedValueOnce(new EfApiError('too big', { status: 422 }))
      .mockResolvedValueOnce('f3');

    const results = await runChecks(makeApi({ uploadFont }), ['a.ttf', 'b.ttf', 'c.ttf'], { timeoutMs: 60000 });

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toMatchObject({ file: 'b.ttf', ok: false, error: 'too big' });
    expect(results[1]).not.toHaveProperty('quota');
  });

  it('stops on a quota error and records the remaining fonts as skipped: quota', async () => {
    const uploadFont = vi
      .fn()
      .mockResolvedValueOnce('f1')
      .mockRejectedValueOnce(new EfApiError('used up', { status: 429, type: 'allowance_exhausted' }));

    const results = await runChecks(makeApi({ uploadFont }), ['a.ttf', 'b.ttf', 'c.ttf'], { timeoutMs: 60000 });

    expect(uploadFont).toHaveBeenCalledTimes(2);
    expect(results[1]).toMatchObject({ file: 'b.ttf', ok: false, quota: true });
    expect(results[2]).toMatchObject({ file: 'c.ttf', ok: false, quota: true, skipped: 'quota' });
  });

  it('records a failed inspection as an error', async () => {
    const waitForInspection = vi.fn(async () => ({ id: 'i', status: 'failed' }));

    const results = await runChecks(makeApi({ waitForInspection }), ['a.ttf'], { timeoutMs: 60000 });

    expect(results[0]).toMatchObject({ ok: false });
  });

  it.each([
    ['a 5xx', new EfApiError('boom', { status: 503 })],
    ['a network error', new EfApiError('down', { status: 0 })],
  ])('throws with a retry hint on %s instead of recording it', async (_name, error) => {
    const uploadFont = vi.fn().mockRejectedValue(error);

    await expect(runChecks(makeApi({ uploadFont }), ['a.ttf', 'b.ttf'], { timeoutMs: 60000 })).rejects.toThrow(
      /try again/i,
    );
    expect(uploadFont).toHaveBeenCalledTimes(1);
  });
});

describe('decide', () => {
  const ok = (file: string, score: number, counts: Partial<Inspection['counts']> = {}): FontResult => ({
    file,
    ok: true,
    inspection: inspection(score, counts),
  });
  const base = { failOn: 'error' as const, failOnQuota: false };

  it.each([
    ['error', { error: 1 }, true],
    ['error', { warning: 3 }, false],
    ['warning', { warning: 1 }, true],
    ['warning', { error: 1 }, true],
    ['warning', { info: 4 }, false],
    ['none', { error: 5, warning: 5 }, false],
  ] as const)('failOn %s with %j fails=%s', (failOn, counts, failed) => {
    expect(decide([ok('a.ttf', 90, counts)], { ...base, failOn }).failed).toBe(failed);
  });

  it('fails when a score is below failBelow, and not at the threshold', () => {
    const below = decide([ok('a.ttf', 70), ok('b.ttf', 95)], { ...base, failOn: 'none', failBelow: 80 });
    const at = decide([ok('a.ttf', 80)], { ...base, failOn: 'none', failBelow: 80 });

    expect(below.failed).toBe(true);
    expect(below.reasons).toHaveLength(1);
    expect(below.reasons[0]).toContain('a.ttf');
    expect(at.failed).toBe(false);
  });

  it('treats a per-font refusal as a failure reason, even with failOn none', () => {
    const decision = decide([{ file: 'a.ttf', ok: false, error: 'too big' }], { ...base, failOn: 'none' });

    expect(decision.failed).toBe(true);
    expect(decision.reasons[0]).toContain('too big');
  });

  it('counts quota only when failOnQuota is set', () => {
    const results: FontResult[] = [{ file: 'a.ttf', ok: false, error: 'used up', quota: true }];

    expect(decide(results, { ...base, failOnQuota: false })).toEqual({ failed: false, reasons: [] });
    expect(decide(results, { ...base, failOnQuota: true }).failed).toBe(true);
  });
});
