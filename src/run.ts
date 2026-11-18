import * as core from '@actions/core';
import { relative } from 'node:path';
import * as github from '@actions/github';
import pkg from '../package.json';
import { EfApi } from './api';
import type { Allowance } from './api';
import { decide, runChecks, type FontResult } from './check';
import { findFonts } from './fonts';
import { annotate, markdownReport, summarize, upsertComment } from './report';
import {
  isPullRequestEvent,
  parseApiUrl,
  parseFailBelow,
  parseFailOn,
  parseTimeoutMinutes,
  resolveToggle,
} from './inputs';

/** changed-only was asked for where it cannot work: a configuration error, not a GitHub API failure. */
class ChangedOnlyConfigError extends Error {}

async function changedFilesInPullRequest(token: string): Promise<string[]> {
  const pullNumber = github.context.payload.pull_request?.number;
  if (!token || pullNumber === undefined) {
    throw new ChangedOnlyConfigError('changed-only needs github-token and a pull request payload to list the changed files.');
  }
  const octokit = github.getOctokit(token);
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    ...github.context.repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files.filter((file) => file.status !== 'removed').map((file) => file.filename);
}

let outputsSet = false;

function setOutputs(results: string, failed: boolean): void {
  core.setOutput('results', results);
  core.setOutput('failed', String(failed));
  outputsSet = true;
}

/** Called when run() throws: makes sure the outputs exist and the job fails. */
export function handleFailure(error: unknown): void {
  if (!outputsSet) {
    setOutputs('[]', true);
  }
  core.setFailed(error instanceof Error ? error.message : String(error));
}

export async function run(): Promise<void> {
  outputsSet = false;
  const apiKey = core.getInput('api-key');
  if (apiKey === '') {
    core.setOutput('results', '[]');
    core.setOutput('failed', 'false');
    core.notice('Font Check skipped: no api-key (secrets are not available to pull requests from forks).');
    return;
  }
  core.setSecret(apiKey);
  const apiUrl = parseApiUrl(core.getInput('api-url'));

  const isPullRequest = isPullRequestEvent(github.context.eventName);
  const changedOnly = resolveToggle('changed-only', core.getInput('changed-only'), isPullRequest);
  const comment = resolveToggle('comment', core.getInput('comment'), isPullRequest);
  const failOn = parseFailOn(core.getInput('fail-on'));
  const failBelow = parseFailBelow(core.getInput('fail-below'));
  const failOnQuota = resolveToggle('fail-on-quota', core.getInput('fail-on-quota'), false);
  const timeoutMinutes = parseTimeoutMinutes(core.getInput('timeout-minutes'));
  const timeoutMs = timeoutMinutes * 60000;
  core.debug(`changed-only=${changedOnly} comment=${comment}`);

  let changedFiles: string[] | undefined;
  let onlyChanged = changedOnly;
  if (changedOnly) {
    try {
      changedFiles = await changedFilesInPullRequest(core.getInput('github-token'));
    } catch (error) {
      if (error instanceof ChangedOnlyConfigError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      core.warning(`Could not list the pull request's files \u2014 checking all matched fonts. (${reason})`);
      onlyChanged = false;
    }
  }
  const files = await findFonts({ patterns: core.getInput('paths'), changedOnly: onlyChanged, changedFiles });
  if (files.length === 0) {
    core.info('No fonts to check');
    core.setOutput('results', '[]');
    core.setOutput('failed', 'false');
    return;
  }

  const api = new EfApi({
    baseUrl: apiUrl,
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
  setOutputs(JSON.stringify(summarize(shown)), decision.failed);

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
