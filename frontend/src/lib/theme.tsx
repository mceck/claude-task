// Light/dark theme with a stored preference. index.html applies it before first paint.
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'dark' | 'light' | 'system';
const STORAGE_KEY = 'theme';

interface ThemeState {
  theme: Theme;
  resolvedTheme: 'dark' | 'light';
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeState>({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} });

const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

function readStored(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);
  const [prefersDark, setPrefersDark] = useState(systemDark);
  const resolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setPrefersDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  };

  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
