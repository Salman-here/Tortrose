/**
 * ThemeContext
 *
 * Provides light/dark/system theme modes with AsyncStorage persistence.
 *
 * Usage:
 *   const { palette, mode, isDark, setMode } = useTheme();
 *   const styles = useThemedStyles((p) => ({ container: { backgroundColor: p.colors.background } }));
 */

import React, { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lightPalette, darkPalette } from '../styles/palettes';

const STORAGE_KEY = 'app_theme_mode'; // 'light' | 'dark' | 'system'

const ThemeContext = createContext({
  mode: 'system',
  resolvedMode: 'light',
  isDark: false,
  palette: lightPalette,
  setMode: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }) {
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null
  const [mode, setModeState] = useState('light'); // saved preference — default light to match the website
  const [hydrated, setHydrated] = useState(false);

  // Hydrate saved preference once
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === 'light' || saved === 'dark' || saved === 'system') {
          setModeState(saved);
        }
      } catch {
        /* ignore */
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  // Persist whenever mode changes (after hydration)
  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => {});
  }, [mode, hydrated]);

  const resolvedMode = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;
  const isDark = resolvedMode === 'dark';
  const palette = isDark ? darkPalette : lightPalette;

  const setMode = useCallback((next) => {
    if (next === 'light' || next === 'dark' || next === 'system') {
      setModeState(next);
    }
  }, []);

  const toggle = useCallback(() => {
    setModeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo(
    () => ({ mode, resolvedMode, isDark, palette, setMode, toggle }),
    [mode, resolvedMode, isDark, palette, setMode, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context || !context.palette) {
    // Fallback to light palette if context not ready
    return {
      mode: 'system',
      resolvedMode: 'light',
      isDark: false,
      palette: lightPalette,
      setMode: () => {},
      toggle: () => {},
    };
  }
  return context;
}

/**
 * useThemedStyles — memoized factory.
 * Pass a function `(palette) => StyleSheet-compatible object`. Recomputes when palette swaps.
 */
export function useThemedStyles(factory) {
  const { palette } = useTheme();
  // Use a ref to avoid recomputing if factory identity changes inline (common pattern)
  const factoryRef = useRef(factory);
  factoryRef.current = factory;
  return useMemo(() => factoryRef.current(palette), [palette]);
}

export default ThemeContext;
