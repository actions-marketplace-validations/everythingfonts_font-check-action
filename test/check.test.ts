import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EfApiError, type EfApi, type Inspection } from '../src/api';
import { ApiKeyRejectedError, decide, runChecks, type FontResult } from '../src/check';

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

  it('skips a font over the 10 MB CI-key cap without uploading it, as a quota warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-size-'));
    const big = join(dir, 'Big.ttf');
    const atCap = join(dir, 'AtCap.ttf');
    writeFileSync(big, '');
    truncateSync(big, 10485761);
    writeFileSync(atCap, '');
    truncateSync(atCap, 10485760);
    const api = makeApi();

    const results = await runChecks(api, [big, atCap], { timeoutMs: 60000 });

    expect(api.uploadFont).toHaveBeenCalledTimes(1);
    expect(api.uploadFont).toHaveBeenCalledWith(atCap);
    expect(results[0]).toEqual({ file: big, ok: false, error: 'Larger than the 10 MB a CI key accepts \u2014 skipped', quota: true });
    expect(results[1]).toMatchObject({ file: atCap, ok: true });
    expect(decide(results, { failOn: 'error', failOnQuota: false }).failed).toBe(false);
    expect(decide(results, { failOn: 'error', failOnQuota: true }).failed).toBe(true);
  });

  it('treats an upload 422 about the size limit like an oversized font and checks the next one', async () => {
    const uploadFont = vi
      .fn()
      .mockRejectedValueOnce(
        new EfApiError("Everything Fonts API error (422): This font is 12 MB, above your plan's 10 MB limit.", { status: 422 }),
      )
      .mockResolvedValueOnce('f2');

    const results = await runChecks(makeApi({ uploadFont }), ['a.ttf', 'b.ttf'], { timeoutMs: 60000 });

    expect(results[0]).toEqual({ file: 'a.ttf', ok: false, error: 'Larger than the 10 MB a CI key accepts \u2014 skipped', quota: true });
    expect(results[1]).toMatchObject({ file: 'b.ttf', ok: true });
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

    expect(results[0]).toEqual({ file: 'a.ttf', ok: false, error: 'The inspection failed on the server.' });
  });

  it("includes the API's error string in a failed inspection", async () => {
    const waitForInspection = vi.fn(async () => ({ id: 'i', status: 'failed', error: '  The font has no cmap table.  ' }));

    const results = await runChecks(makeApi({ waitForInspection }), ['a.ttf'], { timeoutMs: 60000 });

    expect(results[0]).toEqual({ file: 'a.ttf', ok: false, error: 'The inspection failed on the server: The font has no cmap table.' });
  });

  it.each([
    ['a 5xx', new EfApiError('boom', { status: 503 })],
    ['a network error', new EfApiError('down', { status: 0 })],
    ['a plain 429 that ran out of retries', new EfApiError('Too Many Attempts.', { status: 429 })],
  ])('throws with a retry hint on %s instead of recording it', async (_name, error) => {
    const uploadFont = vi.fn().mockRejectedValue(error);

    await expect(runChecks(makeApi({ uploadFont }), ['a.ttf', 'b.ttf'], { timeoutMs: 60000 })).rejects.toThrow(
      /try again/i,
    );
    expect(uploadFont).toHaveBeenCalledTimes(1);
  });
});

describe('runChecks key rejection and timeouts', () => {
  it.each([401, 403])('aborts the run on HTTP %i with the key message', async (status) => {
    const uploadFont = vi.fn().mockRejectedValue(new EfApiError('nope', { status }));

    const error = await runChecks(makeApi({ uploadFont }), ['a.ttf', 'b.ttf'], { timeoutMs: 60000 }).catch((e: unknown) => e);

    expect(uploadFont).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiKeyRejectedError);
    expect((error as Error).message).toBe(
      `Everything Fonts rejected the API key (HTTP ${status}). Check the api-key secret (EVERYTHINGFONTS_CI_KEY) \u2014 a CI key can only upload fonts and run health checks.`,
    );
  });

  it('skips the remaining fonts as timeout once the deadline has passed', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const uploadFont = vi.fn(async () => {
      now += 70000;
      return 'f1';
    });
    const waitForInspection = vi.fn(async () => inspection(90));

    const results = await runChecks(makeApi({ uploadFont, waitForInspection }), ['a.ttf', 'b.ttf', 'c.ttf'], { timeoutMs: 60000 });
    spy.mockRestore();

    expect(uploadFont).toHaveBeenCalledTimes(1);
    expect(waitForInspection).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ ok: false, error: 'Timed out waiting for the result.' });
    expect(results.slice(1)).toMatchObject([
      { file: 'b.ttf', ok: false, skipped: 'timeout' },
      { file: 'c.ttf', ok: false, skipped: 'timeout' },
    ]);
  });

  it('records a per-font poll timeout for that font only, never passing a zero timeout', async () => {
    const waitForInspection = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timed out waiting for inspection x after 60 seconds.'))
      .mockResolvedValueOnce(inspection(90));

    const results = await runChecks(makeApi({ waitForInspection }), ['a.ttf', 'b.ttf'], { timeoutMs: 60000 });

    expect(results[0]).toMatchObject({ ok: false, error: 'Timed out waiting for the result.' });
    expect(results[1].ok).toBe(true);
    for (const call of waitForInspection.mock.calls) {
      expect(call[1].timeoutMs).toBeGreaterThan(0);
    }
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

  it('fails once with a summary when fonts were skipped for timeout', () => {
    const skipped = (file: string): FontResult => ({ file, ok: false, error: 's', skipped: 'timeout' });

    const decision = decide([skipped('a.ttf'), skipped('b.ttf')], { ...base, timeoutMinutes: 10 });

    expect(decision).toEqual({ failed: true, reasons: ['Timed out after 10 minute(s); 2 fonts not checked'] });
  });
});
