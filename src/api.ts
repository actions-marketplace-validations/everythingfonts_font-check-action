import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface Allowance {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}

export interface Finding {
  code: string;
  severity: string;
  category: string;
  title: string;
}

export interface Inspection {
  id: string;
  status: 'pending' | 'processing' | 'failed' | 'succeeded' | string;
  score?: number;
  band?: 'healthy' | 'needs-attention' | 'unhealthy' | string;
  counts?: { error: number; warning: number; info: number; pass: number };
  findings?: Finding[];
  report_url?: string;
}

export interface EfApiOptions {
  baseUrl: string;
  apiKey: string;
  client: string;
  repo?: string;
  sleep?: (ms: number) => Promise<void>;
}

const QUOTA_TYPES = ['allowance_exhausted', 'upload_limit'];
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_AFTER_SECONDS = 6;
const POLL_START_MS = 2000;
const POLL_CAP_MS = 15000;

/** sha256 hex of `owner/repo`, so the plain repository name is never sent. */
export function repoHash(repository: string): string {
  return createHash('sha256').update(repository).digest('hex');
}

export class EfApiError extends Error {
  status: number;
  type?: string;
  allowance?: Allowance;
  body: unknown;

  constructor(message: string, init: { status: number; type?: string; allowance?: Allowance; body?: unknown }) {
    super(message);
    this.name = 'EfApiError';
    this.status = init.status;
    this.type = init.type;
    this.allowance = init.allowance;
    this.body = init.body;
  }

  isQuota(): boolean {
    return this.status === 429 && this.type !== undefined && QUOTA_TYPES.includes(this.type);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function allowanceFromBody(body: unknown): Allowance | undefined {
  if (!isRecord(body) || !isRecord(body.allowance)) {
    return undefined;
  }
  const a = body.allowance;
  if (typeof a.limit !== 'number') {
    return undefined;
  }
  return {
    limit: a.limit,
    used: Number(a.used ?? 0),
    remaining: Number(a.remaining ?? 0),
    resetsAt: String(a.resets_at ?? ''),
  };
}

function allowanceFromHeaders(headers: Headers): Allowance | undefined {
  const limit = headers.get('X-Allowance-Limit');
  const remaining = headers.get('X-Allowance-Remaining');
  if (limit === null || remaining === null) {
    return undefined;
  }
  const reset = Number(headers.get('X-Allowance-Reset'));
  return {
    limit: Number(limit),
    used: Number(limit) - Number(remaining),
    remaining: Number(remaining),
    resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : '',
  };
}

export class EfApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly client: string;
  private readonly repo?: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: EfApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.client = opts.client;
    this.repo = opts.repo;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async uploadFont(path: string): Promise<string> {
    const bytes = await readFile(path);
    const buildForm = (): FormData => {
      const form = new FormData();
      form.append('font', new Blob([new Uint8Array(bytes)]), basename(path));
      return form;
    };
    const { body } = await this.request('POST', '/font', buildForm);
    return String(this.contents(body).id);
  }

  async inspect(fontId: string): Promise<{ id: string; status: string; allowance: Allowance | null }> {
    const { body, headers } = await this.request('POST', `/font/${encodeURIComponent(fontId)}/inspect`);
    const contents = this.contents(body);
    return {
      id: String(contents.id),
      status: String(contents.status),
      allowance: allowanceFromHeaders(headers) ?? allowanceFromBody(body) ?? null,
    };
  }

  async inspection(id: string): Promise<Inspection> {
    const { body } = await this.request('GET', `/inspections/${encodeURIComponent(id)}`);
    return this.contents(body) as unknown as Inspection;
  }

  async waitForInspection(id: string, opts: { timeoutMs: number }): Promise<Inspection> {
    let elapsed = 0;
    let delay = POLL_START_MS;
    for (;;) {
      const inspection = await this.inspection(id);
      if (inspection.status === 'succeeded' || inspection.status === 'failed') {
        return inspection;
      }
      if (elapsed >= opts.timeoutMs) {
        throw new Error(`Timed out waiting for inspection ${id} after ${Math.round(opts.timeoutMs / 1000)} seconds.`);
      }
      await this.sleep(delay);
      elapsed += delay;
      delay = Math.min(delay * 2, POLL_CAP_MS);
    }
  }

  private contents(body: unknown): Record<string, unknown> {
    if (isRecord(body) && isRecord(body.contents)) {
      return body.contents;
    }
    throw new EfApiError('Unexpected response from the Everything Fonts API.', { status: 200, body });
  }

  private headers(): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'X-EverythingFonts-Client': this.client,
    });
    if (this.repo) {
      headers.set('X-EverythingFonts-Repo', repoHash(this.repo));
    }
    return headers;
  }

  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('***') : text;
  }

  private async request(
    method: string,
    path: string,
    makeBody?: () => FormData,
  ): Promise<{ body: unknown; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, { method, headers: this.headers(), body: makeBody?.() });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new EfApiError(this.scrub(`Could not reach the Everything Fonts API: ${reason}`), { status: 0 });
      }

      const text = await response.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = text;
      }

      if (response.ok) {
        return { body, headers: response.headers };
      }

      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
      const type = typeof error?.type === 'string' ? error.type : undefined;
      const isQuota = response.status === 429 && type !== undefined && QUOTA_TYPES.includes(type);

      if (response.status === 429 && !isQuota && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_SECONDS;
        await this.sleep(seconds * 1000);
        continue;
      }

      const message =
        (typeof error?.message === 'string' && error.message) ||
        (isRecord(body) && typeof body.message === 'string' && body.message) ||
        `HTTP ${response.status}`;
      throw new EfApiError(this.scrub(`Everything Fonts API error (${response.status}): ${message}`), {
        status: response.status,
        type,
        allowance: allowanceFromBody(body) ?? allowanceFromHeaders(response.headers),
        body,
      });
    }
  }
}
