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
  maxChars?: number;
}

export interface ResultSummary {
  file: string;
  score: number | null;
  band: string | null;
  counts: { error: number; warning: number; info: number; pass: number } | null;
  report_url: string | null;
  error?: string;
}

const MAX_BODY_CHARS = 60000;
const MAX_REASONS = 20;
const MAX_ANNOTATIONS_PER_SEVERITY = 10;

/** Escapes markdown, neutralises @mentions and collapses newlines. */
export function safeText(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\\`*_\[\]()<>|#!]/g, (char) => `\\${char}`)
    .replace(/@/g, '@‍');
}

/** A single-line inline code span that cannot break out of a table cell. */
export function codeSpan(text: string): string {
  const clean = text.replace(/[`\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/@/g, '@\u200D').trim();
  return `\`${clean}\``;
}

/** Only a parseable https URL becomes a link; parentheses are encoded. */
function safeUrl(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') {
      return null;
    }
    return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
  } catch {
    return null;
  }
}

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
  const href = safeUrl(url) ?? safeUrl(reportBase);
  return href ? `[full report](${href})` : '';
}

function renderReport(
  results: FontResult[],
  decision: ReportDecision,
  options: ReportOptions,
  hidden: number,
): string {
  const lines: string[] = [COMMENT_MARKER, '## Font Check', ''];
  lines.push(decision.failed ? '**Result: failed**' : '**Result: passed**', '');
  for (const reason of decision.reasons.slice(0, MAX_REASONS)) {
    lines.push(`- ${safeText(reason)}`);
  }
  if (decision.reasons.length > MAX_REASONS) {
    lines.push(`- \u2026 and ${decision.reasons.length - MAX_REASONS} more \u2014 see the job log`);
  }
  if (decision.reasons.length > 0) {
    lines.push('');
  }

  lines.push('| Font | Score | Health | Errors | Warnings | Info | Report |', '| --- | ---: | :---: | ---: | ---: | ---: | --- |');
  for (const result of results) {
    const file = codeSpan(result.file);
    if (!result.ok) {
      const label = result.skipped === 'timeout' ? 'timed out' : result.skipped === 'quota' ? 'skipped (allowance)' : 'not checked';
      lines.push(`| ${file} | - | ${label} | - | - | - | |`);
      continue;
    }
    const { inspection } = result;
    const band = inspection.band ?? '';
    const emoji = BAND_EMOJI[band] ?? '';
    lines.push(
      `| ${file} | ${inspection.score ?? '-'} | ${emoji} ${safeText(band)} | ${inspection.counts?.error ?? 0} | ${inspection.counts?.warning ?? 0} | ${inspection.counts?.info ?? 0} | ${reportLink(inspection.report_url, options.reportBase)} |`,
    );
  }
  lines.push('');

  for (const result of results) {
    if (!result.ok) {
      lines.push(`${codeSpan(result.file)}: ${safeText(result.error)}`, '');
      continue;
    }
    const findings = (result.inspection.findings ?? []).filter((finding) => finding.severity !== 'pass').slice(0, TOP_FINDINGS);
    if (findings.length === 0) {
      continue;
    }
    lines.push(`${codeSpan(result.file)} top findings`, '');
    for (const finding of findings) {
      lines.push(`- ${safeText(finding.severity)}: ${safeText(finding.title)}`);
    }
    lines.push('');
  }

  if (hidden > 0) {
    lines.push(`… ${hidden} more font${hidden === 1 ? '' : 's'} not shown — see the job log`, '');
  }
  lines.push('---', 'Full report, every finding and one-click fixes: [everythingfonts.com](https://everythingfonts.com)');
  const allowance = options.allowance;
  if (allowance) {
    lines.push('', `${allowance.remaining} of ${allowance.limit} free checks left this month`);
  }
  return lines.join('\n') + '\n';
}

/** Markdown for the PR comment and the job summary, capped in size. */
export function markdownReport(results: FontResult[], decision: ReportDecision, options: ReportOptions = {}): string {
  const max = options.maxChars ?? MAX_BODY_CHARS;
  const full = renderReport(results, decision, options, 0);
  if (full.length <= max) {
    return full;
  }
  let low = 0;
  let high = results.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (renderReport(results.slice(0, mid), decision, options, results.length - mid).length <= max) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return renderReport(results.slice(0, low), decision, options, results.length - low);
}

interface CommentApi {
  rest: {
    issues: {
      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page: number;
        page: number;
      }) => Promise<{ data: Array<{ id: number; body?: string | null; user?: { type?: string } | null }> }>;
      createComment: (params: { owner: string; repo: string; issue_number: number; body: string }) => Promise<unknown>;
      updateComment: (params: { owner: string; repo: string; comment_id: number; body: string }) => Promise<unknown>;
    };
  };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/** Updates our bot-authored marked comment or creates it; any failure only warns. */
export async function upsertComment(
  octokit: CommentApi,
  target: { owner: string; repo: string; issue_number: number },
  body: string,
): Promise<void> {
  try {
    let existingId: number | undefined;
    for (let page = 1; page <= MAX_PAGES && existingId === undefined; page++) {
      const { data } = await octokit.rest.issues.listComments({ ...target, per_page: PAGE_SIZE, page });
      const match = data.find((comment) => comment.user?.type === 'Bot' && comment.body?.includes(COMMENT_MARKER));
      if (match) {
        existingId = match.id;
      }
      if (data.length < PAGE_SIZE) {
        break;
      }
    }
    if (existingId !== undefined) {
      await octokit.rest.issues.updateComment({ owner: target.owner, repo: target.repo, comment_id: existingId, body });
    } else {
      await octokit.rest.issues.createComment({ ...target, body });
    }
  } catch {
    core.warning(
      'Could not post the Font Check comment (the token may need "pull-requests: write"); continuing without it.',
    );
  }
}

/** One annotation per finding (title only), plus refused and skipped fonts; capped per severity. */
export function annotate(results: FontResult[]): void {
  const budget = { error: MAX_ANNOTATIONS_PER_SEVERITY, warning: MAX_ANNOTATIONS_PER_SEVERITY, notice: MAX_ANNOTATIONS_PER_SEVERITY };
  let dropped = 0;
  const emit = (level: 'error' | 'warning' | 'notice', message: string, file: string): void => {
    if (budget[level] <= 0) {
      dropped++;
      return;
    }
    budget[level]--;
    core[level](message, { file });
  };
  for (const result of results) {
    if (!result.ok) {
      emit(result.quota || result.skipped === 'timeout' ? 'warning' : 'error', `${result.file}: ${result.error}`, result.file);
      continue;
    }
    for (const finding of result.inspection.findings ?? []) {
      if (finding.severity === 'error') {
        emit('error', finding.title, result.file);
      } else if (finding.severity === 'warning') {
        emit('warning', finding.title, result.file);
      } else if (finding.severity === 'info') {
        emit('notice', finding.title, result.file);
      }
    }
  }
  if (dropped > 0) {
    core.notice(`${dropped} more findings — see the job summary`);
  }
}
