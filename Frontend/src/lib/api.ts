/** Typed API client for the calc-be backend.
 *
 * All failure modes log WHAT failed with status/timeout/payload context
 * and throw a user-safe Error whose message the UI can display.
 */
import axios, { AxiosError } from 'axios';
import { createLogger } from '@/lib/logger';

const log = createLogger('api');

// Must cover free-model latency (12-58s observed) plus up to 5 backend attempts.
export const CALCULATE_TIMEOUT_MS = 420_000;

export interface CalculateItem {
  expr: string;
  result: string;
  assign: boolean;
}

export interface CalculateResponse {
  message: string;
  data: CalculateItem[];
  status: string;
}

export function getApiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (!raw || !raw.trim()) {
    log.error('getApiBaseUrl: VITE_API_URL is missing. Set it in .env (see .env.example).');
    throw new Error('API URL is not configured (VITE_API_URL). Check .env.');
  }
  const base = raw.trim().replace(/\/+$/, '');
  log.debug(`getApiBaseUrl: using base=${base}`);
  return base;
}

function friendlyFromStatus(status: number, detail: unknown): string {
  const d = typeof detail === 'string' && detail ? `: ${detail.slice(0, 300)}` : '';
  switch (true) {
    case status === 400:
      return `Bad image request (400)${d}`;
    case status === 429:
      return `Rate limited by the vision provider (429). Wait a minute and retry${d}`;
    case status === 504:
      return `Vision request timed out (504). The free model is slow — retry${d}`;
    case status >= 500:
      return `Server failed (${status})${d}`;
    default:
      return `Request failed (${status})${d}`;
  }
}

/** POST canvas image to /calculate. Logs start/success and every error path. */
export async function calculate(
  imageDataUrl: string,
  dictOfVars: Record<string, unknown>,
): Promise<CalculateResponse> {
  if (!imageDataUrl || !imageDataUrl.startsWith('data:image/')) {
    log.error('calculate: refused to send — image is not a data:image/... URL');
    throw new Error('Canvas image is empty or invalid. Draw something first.');
  }

  const base = getApiBaseUrl();
  const url = `${base}/calculate`;
  const started = performance.now();
  log.info(
    `calculate: POST ${url} payload_chars=${imageDataUrl.length} vars=${JSON.stringify(dictOfVars).slice(0, 300)}`,
  );

  try {
    const res = await axios.post<CalculateResponse>(
      url,
      { image: imageDataUrl, dict_of_vars: dictOfVars },
      { timeout: CALCULATE_TIMEOUT_MS, headers: { 'Content-Type': 'application/json' } },
    );
    const ms = Math.round(performance.now() - started);
    const n = Array.isArray(res.data?.data) ? res.data.data.length : -1;
    log.info(`calculate: HTTP ${res.status} in ${ms}ms answers=${n}`);
    if (!res.data || !Array.isArray(res.data.data)) {
      log.error('calculate: malformed success body (missing data array)', res.data);
      throw new Error('Server returned a malformed response. See console.');
    }
    return res.data;
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError<{ detail?: unknown }>;
      if (ax.code === 'ECONNABORTED' || /timeout/i.test(ax.message)) {
        log.error(`calculate: timeout after ${ms}ms (limit ${CALCULATE_TIMEOUT_MS}ms) to ${url}`);
        throw new Error(`Vision request timed out after ${Math.round(ms / 1000)}s. Retry.`, { cause: err });
      }
      if (ax.response) {
        const status = ax.response.status;
        const detail = (ax.response.data as { detail?: unknown } | undefined)?.detail;
        log.error(`calculate: HTTP ${status} after ${ms}ms detail=${JSON.stringify(detail)?.slice(0, 500)}`);
        throw new Error(friendlyFromStatus(status, detail), { cause: err });
      }
      if (ax.request) {
        log.error(`calculate: no response after ${ms}ms — backend unreachable at ${base}. Is 'python main.py' running?`, ax.message);
        throw new Error(`Cannot reach backend at ${base}. Start it with 'python main.py'.`, { cause: err });
      }
    }
    log.error(`calculate: unexpected failure after ${ms}ms`, err);
    throw err instanceof Error ? err : new Error('Unexpected calculation failure. See console.');
  }
}
