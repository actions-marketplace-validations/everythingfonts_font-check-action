import * as core from '@actions/core';
import { relative } from 'node:path';
import * as github from '@actions/github';
import pkg from '../package.json';
import { EfApi } from './api';
import type { Allowance } from './api';
import { decide, runChecks, type FontResult } from './check';
import { findFonts } from './fonts';
import { annotate, markdownReport, summarize, upsertComment } from './report';
import { isPullRequestEvent, parseFailBelow, parseFailOn, parseTimeoutMinutes, resolveToggle } from './inputs';

async function changedFilesInPullRequest(token: string): Promise<string[]> {
  const pullNumber = github.context.payload.pull_request?.number;
  if (!token || pullNumber === undefined) {
    throw new Error('changed-only needs github-token and a pull request payload to list the changed files.');
  }
  const octokit = github.getOctokit(token);
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    ...github.context.repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files.filter((file) => file.status !== 'removed').map((file) => file.filename);
}

export async function run(): Promise<void> {
  const apiKey = core.getInput('api-key');
  if (apiKey === '') {
    core.setOutput('results', '[]');
    core.setOutput('failed', 'false');
    core.notice('Font Check skipped: no api-key (secrets are not available to pull requests from forks).');
    return;
  }
  core.setSecret(apiKey);

  const isPullRequest = isPullRequestEvent(github.context.eventName);
  const changedOnly = resolveToggle('changed-only', core.getInput('changed-only'), isPullRequest);
  const comment = resolveToggle('comment', core.getInput('comment'), isPullRequest);
  const failOn = parseFailOn(core.getInput('fail-on'));
  const failBelow = parseFailBelow(core.getInput('fail-below'));
  const failOnQuota = resolveToggle('fail-on-quota', core.getInput('fail-on-quota'), false);
  const timeoutMinutes = parseTimeoutMinutes(core.getInput('timeout-minutes'));
  const timeoutMs = timeoutMinutes * 60000;
  core.debug(`changed-only=${changedOnly} comment=${comment}`);

  const changedFiles = changedOnly ? await changedFilesInPullRequest(core.getInput('github-token')) : undefined;
  const files = await findFonts({ patterns: core.getInput('paths'), changedOnly, changedFiles });
  if (files.length === 0) {
    core.info('No fonts to check');
    core.setOutput('results', '[]');
    core.setOutput('failed', 'false');
    return;
  }

  const api = new EfApi({
    baseUrl: core.getInput('api-url'),
    apiKey,
    client: `github-action/font-check@${pkg.version}`,
    repo: process.env.GITHUB_REPOSITORY,
  });
  const latest: { allowance: Allowance | null } = { allowance: null };
  const results = await runChecks(api, files, { timeoutMs, onAllowance: (value) => (latest.allowance = value) });

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const shown: FontResult[] = results.map((result) => ({
    ...result,
    file: relative(workspace, result.file).split('\\').join('/'),
  }));
  const decision = decide(shown, { failBelow, failOn, failOnQuota, timeoutMinutes });
  annotate(shown);
  core.setOutput('results', JSON.stringify(summarize(shown)));
  core.setOutput('failed', String(decision.failed));

  const markdown = markdownReport(shown, decision, { allowance: latest.allowance });
  await core.summary.addRaw(markdown, true).write();
  const pullNumber = github.context.payload.pull_request?.number;
  if (comment && pullNumber !== undefined) {
    const token = core.getInput('github-token');
    if (token) {
      await upsertComment(github.getOctokit(token), { ...github.context.repo, issue_number: pullNumber }, markdown);
    }
  }

  if (decision.failed) {
    core.setFailed(`Font Check failed:\n${decision.reasons.join('\n')}`);
  }
}
