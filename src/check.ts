import { stat } from 'node:fs/promises';
import { EfApiError, type Allowance, type EfApi, type Inspection } from './api';

export type FontResult =
  | { file: string; ok: true; inspection: Inspection }
  | { file: string; ok: false; error: string; quota?: boolean; skipped?: 'quota' | 'timeout' };

export interface DecideOptions {
  failBelow?: number;
  failOn: 'error' | 'warning' | 'none';
  failOnQuota: boolean;
  timeoutMinutes?: number;
}

/** The largest font a CI key accepts (10 MB). */
export const CI_KEY_MAX_UPLOAD_BYTES = 10485760;
export const OVERSIZED_MESSAGE = 'Larger than the 10 MB a CI key accepts \u2014 skipped';

const TIMED_OUT_WAITING = 'Timed out waiting for the result.';
const RETRY_HINT = 'The Everything Fonts API is unavailable; try again in a few minutes.';

const KEY_REJECTED_HINT =
  'Check the api-key secret (EVERYTHINGFONTS_CI_KEY) \u2014 a CI key can only upload fonts and run health checks.';

/** The API refused the key; every later request would fail the same way. */
export class ApiKeyRejectedError extends Error {
  constructor(public readonly status: number) {
    super(`Everything Fonts rejected the API key (HTTP ${status}). ${KEY_REJECTED_HINT}`);
    this.name = 'ApiKeyRejectedError';
  }
}

const isKeyRejected = (error: unknown): error is EfApiError =>
  error instanceof EfApiError && (error.status === 401 || (error.status === 403 && !error.isQuota()));

const isPlainRateLimit = (error: unknown): error is EfApiError =>
  error instanceof EfApiError && error.status === 429 && !error.isQuota();

/** An upload refused with 422 because the font is over the key's size limit. */
const isSizeRefusal = (error: unknown): boolean =>
  error instanceof EfApiError && error.status === 422 && /\blimit\b|too large|larger than|greater than/i.test(error.message);

/** A missing or unreadable file is left to the upload, which reports it. */
async function isOversized(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > CI_KEY_MAX_UPLOAD_BYTES;
  } catch {
    return false;
  }
}

const isOutage = (error: unknown): error is EfApiError =>
  error instanceof EfApiError && (error.status === 0 || error.status >= 500);

/** Checks the fonts one at a time; a quota error skips the rest, an outage throws. */
export async function runChecks(
  api: EfApi,
  files: string[],
  opts: { timeoutMs: number; onAllowance?: (allowance: Allowance) => void },
): Promise<FontResult[]> {
  const deadline = Date.now() + opts.timeoutMs;
  const results: FontResult[] = [];

  for (const [index, file] of files.entries()) {
    if (Date.now() >= deadline) {
      for (const skipped of files.slice(index)) {
        results.push({ file: skipped, ok: false, error: 'Skipped: timed out before this font was checked.', skipped: 'timeout' });
      }
      return results;
    }
    if (await isOversized(file)) {
      results.push({ file, ok: false, error: OVERSIZED_MESSAGE, quota: true });
      continue;
    }
    try {
      const fontId = await api.uploadFont(file);
      const started = await api.inspect(fontId);
      if (started.allowance) {
        opts.onAllowance?.(started.allowance);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(TIMED_OUT_WAITING);
      }
      const inspection = await api.waitForInspection(started.id, { timeoutMs: remaining });
      if (inspection.status === 'succeeded') {
        results.push({ file, ok: true, inspection });
      } else {
        results.push({ file, ok: false, error: 'The inspection failed on the server.' });
      }
    } catch (error) {
      if (isKeyRejected(error)) {
        throw new ApiKeyRejectedError(error.status);
      }
      if (isPlainRateLimit(error)) {
        throw new Error(`Rate limited by Everything Fonts \u2014 try again shortly. ${error.message}`);
      }
      if (isOutage(error)) {
        throw new Error(`${error.message} ${RETRY_HINT}`);
      }
      if (isSizeRefusal(error)) {
        results.push({ file, ok: false, error: OVERSIZED_MESSAGE, quota: true });
        continue;
      }
      const message =
        error instanceof Error && /^Timed out waiting for inspection/.test(error.message)
          ? TIMED_OUT_WAITING
          : error instanceof Error
            ? error.message
            : String(error);
      if (error instanceof EfApiError && error.isQuota()) {
        if (error.allowance) {
          opts.onAllowance?.(error.allowance);
        }
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

  const timedOut = results.filter((result) => !result.ok && result.skipped === 'timeout').length;
  if (timedOut > 0) {
    const minutes = options.timeoutMinutes === undefined ? '' : ` ${options.timeoutMinutes} minute(s)`;
    reasons.push(`Timed out after${minutes || ' the time limit'}; ${timedOut} font${timedOut === 1 ? '' : 's'} not checked`);
  }

  for (const result of results) {
    if (!result.ok) {
      if (result.skipped === 'timeout') {
        continue;
      }
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
