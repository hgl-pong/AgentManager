export type ThemeMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'agentmanager.theme';

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; title: string }> = [
  { value: 'light', label: '浅色', title: '浅色主题' },
  { value: 'dark', label: '深色', title: '深色主题' },
  { value: 'auto', label: '跟随系统', title: '跟随系统主题' },
];

export function loadTheme(): ThemeMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'auto') return value;
  } catch {
    // Private windows can throw on storage access; fall back to the system theme.
  }
  return 'auto';
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'auto') {
    root.removeAttribute('data-theme');
    root.style.colorScheme = '';
    return;
  }
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

export function rememberTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures; the theme still applies for this session.
  }
}
