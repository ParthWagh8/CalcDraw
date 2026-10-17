/** Scoped, leveled logger for CalcDraw frontend.
 *
 * Every branch that can fail must log through here with enough context
 * (scope, action, sizes, status codes) to debug from console output alone.
 * Level is controlled by VITE_LOG_LEVEL (debug|info|warn|error, default info).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function activeLevel(): LogLevel {
  const raw = (import.meta.env.VITE_LOG_LEVEL as string | undefined)?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

export function createLogger(scope: string) {
  const prefix = `[calc-fe:${scope}]`;
  const enabled = (level: LogLevel) => ORDER[level] >= ORDER[activeLevel()];

  return {
    debug: (msg: string, ...args: unknown[]) => {
      if (enabled('debug')) console.debug(`${stamp()} DEBUG ${prefix} ${msg}`, ...args);
    },
    info: (msg: string, ...args: unknown[]) => {
      if (enabled('info')) console.info(`${stamp()} INFO  ${prefix} ${msg}`, ...args);
    },
    warn: (msg: string, ...args: unknown[]) => {
      if (enabled('warn')) console.warn(`${stamp()} WARN  ${prefix} ${msg}`, ...args);
    },
    error: (msg: string, ...args: unknown[]) => {
      // errors always log regardless of level
      console.error(`${stamp()} ERROR ${prefix} ${msg}`, ...args);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
