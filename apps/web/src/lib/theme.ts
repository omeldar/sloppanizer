import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "sloppanizer.theme";

/** Stored choice, else the system preference (first start), else dark. */
export function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Storage blocked: fall through to the system preference.
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const listeners = new Set<() => void>();
let current: Theme = typeof window === "undefined" ? "dark" : initialTheme();

export function applyTheme(theme: Theme): void {
  current = theme;
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Not stored; the theme still applies for this visit.
  }
  for (const listener of listeners) listener();
}

export function toggleTheme(): void {
  setTheme(current === "dark" ? "light" : "dark");
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
