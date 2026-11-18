import * as core from '@actions/core';
import * as github from '@actions/github';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EfApi, EfApiError } from '../src/api';

vi.mock('@actions/core', () => {
  const summary = { addRaw: vi.fn(() => summary), write: vi.fn(async () => summary) };
  return {
    getInput: vi.fn(),
    setSecret: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    summary,
  };
});
vi.mock('@actions/github', () => ({
  context: { eventName: 'push', payload: {}, repo: { owner: 'o', repo: 'r' } },
  getOctokit: vi.fn(),
}));

const apiMock = { uploadFont: vi.fn(), inspect: vi.fn(), waitForInspection: vi.fn() };
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  EfApi: vi.fn(function () {
    return apiMock;
  }),
}));
vi.mock('../src/fonts', () => ({ findFonts: vi.fn(async () => ['/ws/a.ttf', '/ws/b.ttf']) }));

import { handleFailure, run } from '../src/run';

const setInputs = (inputs: Record<string, string>): void => {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '');
};

const succeeded = (errors: number) => ({
  id: 'i',
  status: 'succeeded',
  score: 80,
  band: 'needs-attention',
  counts: { error: errors, warning: 0, info: 0, pass: 1 },
  findings: errors > 0 ? [{ code: 'x', severity: 'error', category: 'c', title: 'Bad table' }] : [],
  report_url: 'https://everythingfonts.com/r/1',
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_WORKSPACE = '/ws';
  apiMock.uploadFont.mockImplementation(async (path: string) => path);
  apiMock.inspect.mockImplementation(async (id: string) => ({ id, status: 'pending', allowance: { limit: 100, used: 1, remaining: 99, resetsAt: '' } }));
  apiMock.waitForInspection.mockResolvedValue(succeeded(0));
});

describe('run', () => {
  it('exits 0 with a notice for a fork PR without a key', async () => {
    setInputs({});
    await run();

    expect(core.notice).toHaveBeenCalledWith(expect.stringContaining('no api-key'));
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('failed', 'false');
  });

  it('annotates a refused font and still checks the others', async () => {
    setInputs({ 'api-key': 'secret-key', 'fail-on': 'none', 'api-url': 'https://x' });
    apiMock.uploadFont.mockRejectedValueOnce(new EfApiError('Font too big', { status: 422 }));
    await run();

    expect(core.error).toHaveBeenCalledWith('a.ttf: Font too big', { file: 'a.ttf' });
    expect(apiMock.waitForInspection).toHaveBeenCalledTimes(1);
    const results = JSON.parse(vi.mocked(core.setOutput).mock.calls.find((c) => c[0] === 'results')![1] as string);
    expect(results.map((r: { file: string }) => r.file)).toEqual(['a.ttf', 'b.ttf']);
    expect(JSON.stringify(vi.mocked(core.summary.addRaw).mock.calls)).not.toContain('secret-key');
  });

  it('calls setFailed when fail-on error meets an error count', async () => {
    setInputs({ 'api-key': 'k', 'fail-on': 'error', 'api-url': 'https://x' });
    apiMock.waitForInspection.mockResolvedValueOnce(succeeded(2)).mockResolvedValueOnce(succeeded(0));
    await run();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('a.ttf: 2 errors'));
    expect(core.setOutput).toHaveBeenCalledWith('failed', 'true');
    expect(core.summary.write).toHaveBeenCalled();
  });

  it('posts the PR comment on a pull request and skips it when comment is false', async () => {
    const createComment = vi.fn(async (_params: { body: string }) => ({}));
    vi.mocked(github.getOctokit).mockReturnValue({
      rest: { issues: { listComments: vi.fn(async () => ({ data: [] })), createComment, updateComment: vi.fn() } },
    } as never);
    Object.assign(github.context, { eventName: 'pull_request', payload: { pull_request: { number: 5 } } });
    setInputs({ 'api-key': 'k', 'changed-only': 'false', 'github-token': 't', 'api-url': 'https://x' });
    await run();

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 5, owner: 'o', repo: 'r' }));
    expect(createComment.mock.calls[0]![0].body).toContain('99 of 100 free checks left this month');

    createComment.mockClear();
    setInputs({ 'api-key': 'k', 'changed-only': 'false', comment: 'false', 'github-token': 't', 'api-url': 'https://x' });
    await run();
    expect(createComment).not.toHaveBeenCalled();
  });

  it('falls back to the default api-url when the input is empty', async () => {
    Object.assign(github.context, { eventName: 'push', payload: {} });
    setInputs({ 'api-key': 'k' });
    await run();

    expect(vi.mocked(EfApi).mock.calls[0]![0]).toMatchObject({ baseUrl: 'https://font.rest/api/v1' });
  });

  it('refuses a plain-http api-url before any request', async () => {
    Object.assign(github.context, { eventName: 'pull_request', payload: { pull_request: { number: 5 } } });
    setInputs({ 'api-key': 'k', 'api-url': 'http://example.com/api/v1', 'github-token': 't' });
    const error = (await run().catch((e: unknown) => e)) as Error;

    expect(error.message).toContain('Input api-url must be an https URL');
    expect(EfApi).not.toHaveBeenCalled();
    expect(github.getOctokit).not.toHaveBeenCalled();
    expect(apiMock.uploadFont).not.toHaveBeenCalled();
  });

  it('sets empty results and failed=true when the run throws', async () => {
    setInputs({ 'api-key': 'k', 'api-url': 'https://x', 'changed-only': 'false' });
    apiMock.uploadFont.mockRejectedValue(new EfApiError('down', { status: 503 }));
    const error = await run().catch((e: unknown) => e);
    handleFailure(error);

    expect(core.setOutput).toHaveBeenCalledWith('results', '[]');
    expect(core.setOutput).toHaveBeenCalledWith('failed', 'true');
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('down'));
  });
});
