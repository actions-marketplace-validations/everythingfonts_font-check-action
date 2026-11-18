import * as core from '@actions/core';
import type { Allowance } from './api';
import type { FontResult } from './check';

export const COMMENT_MARKER = '<!-- everythingfonts-font-check -->';

const BAND_EMOJI: Record<string, string> = {
  healthy: '✅',
  'needs-attention': '⚠️',
  unhealthy: '❌',
};

const TOP_FINDINGS = 5;

export interface ReportDecision {
  failed: boolean;
  reasons: string[];
}

export interface ReportOptions {
  reportBase?: string;
  allowance?: Allowance | null;
}

export interface ResultSummary {
  file: string;
  score: number | null;
  band: string | null;
  counts: { error: number; warning: number; info: number; pass: number } | null;
  report_url: string | null;
  error?: string;
}

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The `results` output: one plain object per font. */
export function summarize(results: FontResult[]): ResultSummary[] {
  return results.map((result) => {
    if (!result.ok) {
      return { file: result.file, score: null, band: null, counts: null, report_url: null, error: result.error };
    }
    const { inspection } = result;
    return {
      file: result.file,
      score: inspection.score ?? null,
      band: inspection.band ?? null,
      counts: inspection.counts ?? null,
      report_url: inspection.report_url ?? null,
    };
  });
}

function reportLink(url: string | undefined, reportBase: string | undefined): string {
  if (url) {
    return `[full report](${url})`;
  }
  return reportBase ? `[full report](${reportBase})` : '';
}

/** Markdown for the PR comment and the job summary. */
export function markdownReport(results: FontResult[], decision: ReportDecision, options: ReportOptions = {}): string {
  const lines: string[] = [COMMENT_MARKER, '## Font Check', ''];
  lines.push(decision.failed ? '**Result: failed**' : '**Result: passed**', '');
  for (const reason of decision.reasons) {
    lines.push(`- ${escapeCell(reason)}`);
  }
  if (decision.reasons.length > 0) {
    lines.push('');
  }

  lines.push('| Font | Score | Health | Errors | Warnings | Info | Report |', '| --- | ---: | :---: | ---: | ---: | ---: | --- |');
  for (const result of results) {
    const file = `\`${result.file.replace(/`/g, '')}\``;
    if (!result.ok) {
      const label = result.skipped === 'timeout' ? 'timed out' : result.skipped === 'quota' ? 'skipped (allowance)' : 'not checked';
      lines.push(`| ${file} | - | ${label} | - | - | - | |`);
      continue;
    }
    const { inspection } = result;
    const band = inspection.band ?? '';
    const emoji = BAND_EMOJI[band] ?? '';
    lines.push(
      `| ${file} | ${inspection.score ?? '-'} | ${emoji} ${band} | ${inspection.counts?.error ?? 0} | ${inspection.counts?.warning ?? 0} | ${inspection.counts?.info ?? 0} | ${reportLink(inspection.report_url, options.reportBase)} |`,
    );
  }
  lines.push('');

  for (const result of results) {
    if (!result.ok) {
      lines.push(`**\`${result.file}\`**: ${escapeCell(result.error)}`, '');
      continue;
    }
    const findings = (result.inspection.findings ?? []).filter((finding) => finding.severity !== 'pass').slice(0, TOP_FINDINGS);
    if (findings.length === 0) {
      continue;
    }
    lines.push(`**\`${result.file}\`** top findings`, '');
    for (const finding of findings) {
      lines.push(`- ${finding.severity}: ${escapeCell(finding.title)}`);
    }
    lines.push('');
  }

  lines.push('---', 'Full report, every finding and one-click fixes: [everythingfonts.com](https://everythingfonts.com)');
  const allowance = options.allowance;
  if (allowance) {
    lines.push('', `${allowance.remaining} of ${allowance.limit} free checks left this month`);
  }
  return lines.join('\n') + '\n';
}

interface CommentApi {
  rest: {
    issues: {
      listComments: unknown;
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<unknown>;
      updateComment: (params: { owner: string; repo: string; comment_id: number; body: string }) => Promise<unknown>;
    };
  };
  paginate: (method: never, params: never) => Promise<Array<{ id: number; body?: string | null }>>;
}

/** Updates the marked comment or creates it; a missing permission only warns. */
export async function upsertComment(
  octokit: CommentApi,
  target: { owner: string; repo: string; issue_number: number },
  body: string,
): Promise<void> {
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments as never, { ...target, per_page: 100 } as never);
    const existing = comments.find((comment) => comment.body?.includes(COMMENT_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: existing.id, body });
    } else {
      await octokit.rest.issues.createComment({ ...target, body });
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403) {
      core.warning('Could not post the Font Check comment: the token needs "pull-requests: write" permission.');
      return;
    }
    throw error;
  }
}

/** One annotation per finding (title only), plus refused and skipped fonts. */
export function annotate(results: FontResult[]): void {
  for (const result of results) {
    const properties = { file: result.file };
    if (!result.ok) {
      if (result.quota || result.skipped === 'timeout') {
        core.warning(`${result.file}: ${result.error}`, properties);
      } else {
        core.error(`${result.file}: ${result.error}`, properties);
      }
      continue;
    }
    for (const finding of result.inspection.findings ?? []) {
      if (finding.severity === 'error') {
        core.error(finding.title, properties);
      } else if (finding.severity === 'warning') {
        core.warning(finding.title, properties);
      } else if (finding.severity === 'info') {
        core.notice(finding.title, properties);
      }
    }
  }
}
