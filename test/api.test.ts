import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EfApi, EfApiError, repoHash } from '../src/api';

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

let fetchMock: ReturnType<typeof vi.fn>;
let sleep: ReturnType<typeof vi.fn>;

const makeApi = (repo: string | undefined = 'owner/repo'): EfApi =>
  new EfApi({
    baseUrl: 'https://font.rest/api/v1',
    apiKey: 'secret-key-123',
    client: 'github-action/font-check@1.0.0',
    repo,
    sleep: sleep as unknown as (ms: number) => Promise<void>,
  });

beforeEach(() => {
  fetchMock = vi.fn();
  sleep = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('headers', () => {
  it('sends the four headers, with the repo as a sha256 of owner/repo', async () => {
    fetchMock.mockResolvedValue(json({ success: { total: 1 }, contents: { id: 'i1', status: 'pending' } }));

    await makeApi().inspection('i1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://font.rest/api/v1/inspections/i1');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key-123');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-EverythingFonts-Client')).toBe('github-action/font-check@1.0.0');
    const expected = createHash('sha256').update('owner/repo').digest('hex');
    expect(headers.get('X-EverythingFonts-Repo')).toBe(expected);
    expect(repoHash('owner/repo')).toBe(expected);
  });
});

describe('uploadFont', () => {
  it('posts multipart with field font and returns contents.id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'efc-'));
    const file = join(dir, 'a.ttf');
    writeFileSync(file, Buffer.from([0, 1, 0, 0]));
    fetchMock.mockResolvedValue(json({ success: { total: 1 }, contents: { id: 'font-9' } }));

    const id = await makeApi().uploadFont(file);

    expect(id).toBe('font-9');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://font.rest/api/v1/font');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const part = (init.body as FormData).get('font') as File;
    expect(part.name).toBe('a.ttf');
    expect(part.size).toBe(4);
  });
});

describe('inspect', () => {
  it('returns id, status and the allowance from headers', async () => {
    fetchMock.mockResolvedValue(
      json(
        { success: { total: 1 }, contents: { id: 'i1', status: 'pending' } },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Allowance-Limit': '100',
            'X-Allowance-Remaining': '99',
            'X-Allowance-Reset': '1796083200',
          },
        },
      ),
    );

    const result = await makeApi().inspect('font-9');

    expect(fetchMock.mock.calls[0][0]).toBe('https://font.rest/api/v1/font/font-9/inspect');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(result).toEqual({
      id: 'i1',
      status: 'pending',
      allowance: { limit: 100, used: 1, remaining: 99, resetsAt: '2026-12-01T00:00:00.000Z' },
    });
  });
});

describe('429 handling', () => {
  it('retries a plain 429 after Retry-After and succeeds on the third try', async () => {
    const throttled = () =>
      json({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'Retry-After': '2' } });
    fetchMock
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(json({ success: { total: 1 }, contents: { id: 'i1', status: 'pending' } }));

    const result = await makeApi().inspection('i1');

    expect(result.id).toBe('i1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
  });

  it('gives up after five retries of a plain 429', async () => {
    fetchMock.mockImplementation(async () => json({ message: 'Too Many Attempts.' }, { status: 429 }));

    await expect(makeApi().inspection('i1')).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledWith(6000);
  });

  it('throws a quota error for allowance_exhausted without retrying', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          message: 'used up',
          error: { code: 429, type: 'allowance_exhausted', message: 'used up' },
          allowance: { limit: 100, used: 100, remaining: 0, resets_at: '2026-12-01T00:00:00Z', plan: 'free' },
        },
        { status: 429 },
      ),
    );

    const error = await makeApi().inspect('font-9').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EfApiError);
    const apiError = error as EfApiError;
    expect(apiError.isQuota()).toBe(true);
    expect(apiError.status).toBe(429);
    expect(apiError.type).toBe('allowance_exhausted');
    expect(apiError.allowance).toEqual({ limit: 100, used: 100, remaining: 0, resetsAt: '2026-12-01T00:00:00Z' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats upload_limit as a quota error', async () => {
    fetchMock.mockResolvedValue(
      json({ message: 'x', error: { code: 429, type: 'upload_limit', message: 'x' } }, { status: 429 }),
    );
    const dir = mkdtempSync(join(tmpdir(), 'efc-'));
    const file = join(dir, 'a.ttf');
    writeFileSync(file, 'x');

    const error = (await makeApi().uploadFont(file).catch((e: unknown) => e)) as EfApiError;

    expect(error.isQuota()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('waitForInspection', () => {
  const state = (status: string, extra: object = {}) =>
    json({ success: { total: 1 }, contents: { id: 'i1', status, ...extra } });

  it('polls pending, processing, succeeded with backoff and returns the summary', async () => {
    fetchMock
      .mockResolvedValueOnce(state('pending'))
      .mockResolvedValueOnce(state('processing'))
      .mockResolvedValueOnce(state('succeeded', { score: 88, band: 'healthy', report_url: 'https://x/r' }));

    const result = await makeApi().waitForInspection('i1', { timeoutMs: 600000 });

    expect(result).toMatchObject({ id: 'i1', status: 'succeeded', score: 88, band: 'healthy' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it('caps the backoff at 15 seconds', async () => {
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(state('pending'));
    }
    fetchMock.mockResolvedValueOnce(state('succeeded'));

    await makeApi().waitForInspection('i1', { timeoutMs: 600000 });

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('returns a failed inspection as is', async () => {
    fetchMock.mockResolvedValueOnce(state('failed'));

    const result = await makeApi().waitForInspection('i1', { timeoutMs: 600000 });

    expect(result.status).toBe('failed');
  });

  it('throws when the timeout passes', async () => {
    fetchMock.mockImplementation(async () => state('pending'));

    await expect(makeApi().waitForInspection('i1', { timeoutMs: 10000 })).rejects.toThrow(/timed out/i);
  });
});

describe('errors', () => {
  it('throws EfApiError with status on a 5xx', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 503, message: 'down' } }, { status: 503 }));

    const error = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(error).toBeInstanceOf(EfApiError);
    expect(error.status).toBe(503);
    expect(error.isQuota()).toBe(false);
    expect(error.message).toContain('down');
  });

  it('never puts the api key in an error message', async () => {
    fetchMock.mockResolvedValue(
      json({ message: 'bad token secret-key-123' }, { status: 401 }),
    );

    const error = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(error.message).not.toContain('secret-key-123');
  });
});
