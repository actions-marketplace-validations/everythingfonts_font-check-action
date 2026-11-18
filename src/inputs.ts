export type FailOn = 'error' | 'warning' | 'none';

/** An explicit 'true'/'false' wins; empty falls back to `fallback`. */
export function resolveToggle(name: string, value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') {
    return fallback;
  }
  if (normalized === 'true' || normalized === 'false') {
    return normalized === 'true';
  }
  throw new Error(`Input ${name} must be true or false, got "${value}".`);
}

export const isPullRequestEvent = (eventName: string): boolean =>
  eventName === 'pull_request' || eventName === 'pull_request_target';

export function parseFailOn(value: string): FailOn {
  const normalized = value.trim().toLowerCase() || 'error';
  if (normalized === 'error' || normalized === 'warning' || normalized === 'none') {
    return normalized;
  }
  throw new Error(`Input fail-on must be one of error, warning, none, got "${value}".`);
}

export function parseFailBelow(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const number = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || number > 100) {
    throw new Error(`Input fail-below must be an integer from 0 to 100, got "${value}".`);
  }
  return number;
}

export function parseTimeoutMinutes(value: string): number {
  const minutes = Number(value.trim() || '10');
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Input timeout-minutes must be a positive number, got "${value}".`);
  }
  return minutes;
}
