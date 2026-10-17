/** Light/dark theme for the brutalist CalcDraw UI.
 *
 * Theme is a `dark` class on <html> (see the Tailwind v4 custom variant in
 * index.css). Persisted in localStorage; every read/write failure is logged.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('theme');

export type Theme = 'light' | 'dark';

const KEY = 'calc-fe:theme';

export function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') {
      log.debug(`getInitialTheme: restored ${saved}`);
      return saved;
    }
    if (saved !== null) log.warn(`getInitialTheme: ignoring invalid value ${saved!}`);
  } catch (e) {
    log.error('getInitialTheme: localStorage unreadable, defaulting to light', e);
  }
  return 'light';
}

export function applyTheme(theme: Theme): void {
  try {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(KEY, theme);
    log.info(`applyTheme: ${theme}`);
  } catch (e) {
    // DOM toggle already applied; only persistence failed.
    log.error(`applyTheme: applied ${theme} to DOM but localStorage write failed`, e);
  }
}

/** Canvas export background per theme (matches the on-screen dot-grid base). */
export function canvasBaseColor(theme: Theme): string {
  return theme === 'dark' ? '#232323' : '#F6F1E5';
}
