import React from 'react';
import { Image as NativeImage } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import StoreAvatar from '../../../src/components/common/StoreAvatar';

jest.mock('expo-image', () => {
  const ReactModule = require('react');
  const { Image } = require('react-native');
  return {
    Image: props => ReactModule.createElement(Image, props),
  };
});

jest.mock('@expo/vector-icons', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    Ionicons: props => ReactModule.createElement(Text, props, props.name),
  };
});

jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: { primary: '#6366f1' },
    },
  }),
}));

describe('StoreAvatar', () => {
  it('renders the real store logo and falls back when that image fails', () => {
    const screen = render(
      <StoreAvatar logo="https://example.com/nova-logo.png" storeName="Nova Nest" />,
    );

    expect(screen.getByLabelText('Nova Nest logo')).toBeTruthy();
    fireEvent(screen.UNSAFE_getByType(NativeImage), 'error');
    expect(screen.getByLabelText('Nova Nest logo unavailable')).toBeTruthy();
  });

  it('uses the fallback immediately when no logo is available', () => {
    const screen = render(<StoreAvatar logo="" storeName="Atlas Aura" />);
    expect(screen.getByLabelText('Atlas Aura logo unavailable')).toBeTruthy();
  });
});
