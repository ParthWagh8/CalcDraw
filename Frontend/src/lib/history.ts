/** Calculation history: append-only log persisted in localStorage.
 *
 * Every mutation logs what changed; corrupt stored data is discarded with an
 * error log rather than crashing the UI.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('history');

export interface HistoryEntry {
  expr: string;
  result: string;
  /** ISO timestamp of when the answer arrived. */
  at: string;
}

const KEY = 'calc-fe:history';
const MAX_ENTRIES = 100;

function isEntry(v: unknown): v is HistoryEntry {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as HistoryEntry).expr === 'string' &&
    typeof (v as HistoryEntry).result === 'string' &&
    typeof (v as HistoryEntry).at === 'string'
  );
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      log.debug('loadHistory: empty');
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.error('loadHistory: stored value is not an array — discarding');
      return [];
    }
    const valid = parsed.filter(isEntry);
    if (valid.length !== parsed.length) {
      log.warn(`loadHistory: dropped ${parsed.length - valid.length} malformed entries`);
    }
    log.info(`loadHistory: restored ${valid.length} entries`);
    return valid;
  } catch (e) {
    log.error('loadHistory: parse/read failed — starting empty', e);
    return [];
  }
}

function persist(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch (e) {
    log.error(`persist: failed to save ${entries.length} entries`, e);
  }
}

/** Prepend entries (newest first), cap length, persist. Returns the new list. */
export function addHistory(prev: HistoryEntry[], items: Omit<HistoryEntry, 'at'>[]): HistoryEntry[] {
  const at = new Date().toISOString();
  const next = [...items.map((i) => ({ ...i, at })), ...prev].slice(0, MAX_ENTRIES);
  log.info(`addHistory: +${items.length} (total ${next.length})`);
  persist(next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  log.info('clearHistory: wiped');
  persist([]);
  return [];
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    log.warn(`formatWhen: invalid timestamp ${iso}`);
    return iso;
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
