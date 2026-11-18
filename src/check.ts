import { EfApiError, type EfApi, type Inspection } from './api';

export type FontResult =
  | { file: string; ok: true; inspection: Inspection }
  | { file: string; ok: false; error: string; quota?: boolean; skipped?: 'quota' };

export interface DecideOptions {
  failBelow?: number;
  failOn: 'error' | 'warning' | 'none';
  failOnQuota: boolean;
}

const RETRY_HINT = 'The Everything Fonts API is unavailable; try again in a few minutes.';

const isOutage = (error: unknown): error is EfApiError =>
  error instanceof EfApiError && (error.status === 0 || error.status >= 500);

/** Checks the fonts one at a time; a quota error skips the rest, an outage throws. */
export async function runChecks(api: EfApi, files: string[], opts: { timeoutMs: number }): Promise<FontResult[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const results: FontResult[] = [];

  for (const [index, file] of files.entries()) {
    try {
      const fontId = await api.uploadFont(file);
      const started = await api.inspect(fontId);
      const inspection = await api.waitForInspection(started.id, { timeoutMs: Math.max(1, deadline - Date.now()) });
      if (inspection.status === 'succeeded') {
        results.push({ file, ok: true, inspection });
      } else {
        results.push({ file, ok: false, error: 'The inspection failed on the server.' });
      }
    } catch (error) {
      if (isOutage(error)) {
        throw new Error(`${error.message} ${RETRY_HINT}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof EfApiError && error.isQuota()) {
        results.push({ file, ok: false, error: message, quota: true });
        for (const skipped of files.slice(index + 1)) {
          results.push({ file: skipped, ok: false, error: 'Skipped: API allowance used up.', quota: true, skipped: 'quota' });
        }
        return results;
      }
      results.push({ file, ok: false, error: message });
    }
  }
  return results;
}

/** Decides whether the job fails; `fail-on` reads `counts`, never the findings list. */
export function decide(results: FontResult[], options: DecideOptions): { failed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  for (const result of results) {
    if (!result.ok) {
      if (!result.quota || options.failOnQuota) {
        reasons.push(`${result.file}: ${result.error}`);
      }
      continue;
    }
    const { counts, score } = result.inspection;
    const errors = counts?.error ?? 0;
    const warnings = counts?.warning ?? 0;
    if (options.failOn === 'error' && errors > 0) {
      reasons.push(`${result.file}: ${errors} error${errors === 1 ? '' : 's'}`);
    } else if (options.failOn === 'warning' && errors + warnings > 0) {
      reasons.push(`${result.file}: ${errors} error(s) and ${warnings} warning(s)`);
    }
    if (options.failBelow !== undefined && typeof score === 'number' && score < options.failBelow) {
      reasons.push(`${result.file}: score ${score} is below ${options.failBelow}`);
    }
  }
  return { failed: reasons.length > 0, reasons };
}
