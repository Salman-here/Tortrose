import React from 'react';
import { Modal as NativeModal, Platform, StyleSheet, Text } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import ThemeContext, { useTheme } from '../../src/contexts/ThemeContext';
import { lightPalette, darkPalette } from '../../src/styles/palettes';
import AppModal from '../../src/components/common/AppModal';
import GlassPanel from '../../src/components/common/GlassPanel';
import GlassBlurFill from '../../src/components/common/GlassBlurFill';
import ModalSurface from '../../src/components/common/ModalSurface';
import { getModalPalette, getModalTokens } from '../../src/styles/modalTheme';

jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('../../src/contexts/GlassBlurContext', () => ({ useGlassBlurTarget: () => ({ current: {} }) }));
const provider = (palette, children) => <ThemeContext.Provider value={{ palette, mode: palette.mode,
  resolvedMode: palette.mode, isDark: palette.mode === 'dark' }}>{children}</ThemeContext.Provider>;
const contrast = (a, b) => {
  const luminance = value => {
    const channels = value.match(/[a-f0-9]{2}/gi).map(channel => parseInt(channel, 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
function PaletteProbe({ id }) {
  const { palette } = useTheme();
  return <Text testID={id} style={{ color: palette.colors.textSecondary }}>{palette.glass.bgStrong}</Text>;
}

test.each([['light', lightPalette], ['dark', darkPalette]])('%s modal neutral text and fields have readable contrast on opaque surfaces', (mode, palette) => {
  const tokens = getModalTokens(palette);
  for (const foreground of [tokens.text, tokens.muted, tokens.subtle]) for (const background of [tokens.surface, tokens.field, tokens.inner]) {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  }
  expect(getModalPalette(palette)).toBe(getModalPalette(palette));
  expect(palette.glass.bgStrong).toMatch(/^rgba/);
});
test.each([['light', lightPalette], ['dark', darkPalette]])('dialog opacity wins over legacy inline glass without blurring the dimmer: %s', (mode, palette) => {
  const view = render(provider(palette, <AppModal visible transparent><GlassPanel testID="panel" variant="modal"
    style={{ backgroundColor: 'rgba(255,255,255,0.1)' }}><GlassBlurFill /><Text>Dialog</Text>
    <GlassPanel variant="inner"><Text>Nested card</Text></GlassPanel></GlassPanel></AppModal>));
  expect(StyleSheet.flatten(view.getByTestId('panel').props.style).backgroundColor).toBe(getModalTokens(palette).surface);
  expect(view.UNSAFE_queryAllByType('BlurView')).toHaveLength(0);
});
test('modal palette stays inside its window and updates when the theme changes', () => {
  const children = <><PaletteProbe id="page" /><AppModal visible transparent><PaletteProbe id="dialog" /></AppModal></>;
  const view = render(provider(lightPalette, children));
  expect(view.getByTestId('page').props.children).toBe(lightPalette.glass.bgStrong);
  expect(view.getByTestId('dialog').props.children).toBe(getModalTokens(lightPalette).surface);
  view.rerender(provider(darkPalette, children));
  expect(view.getByTestId('page').props.children).toBe(darkPalette.glass.bgStrong);
  expect(view.getByTestId('dialog').props.children).toBe(getModalTokens(darkPalette).surface);
});
test('native dismissal, presentation and accessibility props stay intact', () => {
  const onClose = jest.fn();
  const view = render(provider(lightPalette, <AppModal visible transparent animationType="slide" presentationStyle="overFullScreen"
    onRequestClose={onClose} accessibilityViewIsModal><ModalSurface testID="plain-panel"><Text>Content</Text></ModalSurface></AppModal>));
  const modal = view.UNSAFE_getByType(NativeModal);
  expect(modal.props).toMatchObject({ visible: true, transparent: true, animationType: 'slide', presentationStyle: 'overFullScreen', accessibilityViewIsModal: true });
  fireEvent(modal, 'requestClose'); expect(onClose).toHaveBeenCalledTimes(1);
  expect(StyleSheet.flatten(view.getByTestId('plain-panel').props.style).backgroundColor).toBe(getModalTokens(lightPalette).surface);
});
test('ordinary page glass still uses native blur outside a modal', () => {
  const os = Platform.OS, version = Platform.Version;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  Object.defineProperty(Platform, 'Version', { value: 35, configurable: true });
  try {
    const view = render(provider(lightPalette, <GlassPanel variant="strong" testID="page-panel"><Text>Page card</Text></GlassPanel>));
    expect(view.UNSAFE_queryAllByType('BlurView')).toHaveLength(1);
    expect(StyleSheet.flatten(view.getByTestId('page-panel').props.style).backgroundColor).toBe(lightPalette.glass.bgStrong);
  } finally {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    Object.defineProperty(Platform, 'Version', { value: version, configurable: true });
  }
});
