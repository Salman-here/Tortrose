import React from 'react';
import { AppState, Appearance, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, render, waitFor } from '@testing-library/react-native';
import { ThemeProvider, useTheme } from '../../src/contexts/ThemeContext';

function ThemeProbe() {
  const { mode, resolvedMode } = useTheme();
  return <Text testID="theme-state">{`${mode}:${resolvedMode}`}</Text>;
}

describe('ThemeProvider system mode', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    AsyncStorage.clear();
  });

  it('refreshes the device appearance when Android returns to the foreground', async () => {
    let deviceScheme = 'light';
    let appStateListener;

    AsyncStorage.getItem.mockResolvedValueOnce('system');
    jest.spyOn(Appearance, 'getColorScheme').mockImplementation(() => deviceScheme);
    jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
      if (event === 'change') appStateListener = listener;
      return { remove: jest.fn() };
    });

    const view = render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId('theme-state').props.children).toBe('system:light');
    });

    deviceScheme = 'dark';
    act(() => appStateListener('active'));

    await waitFor(() => {
      expect(view.getByTestId('theme-state').props.children).toBe('system:dark');
    });
  });
});
