import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ProductOptionsModal from '../../src/components/common/ProductOptionsModal';

jest.mock('../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        primary: '#0EA5E9',
        success: '#10B981',
        error: '#EF4444',
        text: '#0F172A',
        textSecondary: '#64748B',
        textLight: '#94A3B8',
      },
      glass: {
        bg: 'rgba(255,255,255,0.72)',
        bgStrong: 'rgba(255,255,255,0.84)',
        bgSubtle: 'rgba(255,255,255,0.48)',
        border: 'rgba(255,255,255,0.62)',
        borderStrong: 'rgba(255,255,255,0.76)',
        borderSubtle: 'rgba(255,255,255,0.4)',
      },
      gradients: { cta: ['#14B8A6', '#0EA5E9', '#6366F1'] },
    },
  }),
}));

jest.mock('../../src/components/common/GlassPanel', () => {
  const ReactNative = require('react-native');
  return function MockGlassPanel({ children, variant: _variant, ...props }) {
    return <ReactNative.View {...props}>{children}</ReactNative.View>;
  };
});

jest.mock('expo-linear-gradient', () => {
  const ReactNative = require('react-native');
  return {
    LinearGradient: ({ children, colors: _colors, start: _start, end: _end, ...props }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
  };
});

jest.mock('@expo/vector-icons', () => {
  const ReactNative = require('react-native');
  return { Ionicons: ({ name }) => <ReactNative.Text>{name}</ReactNative.Text> };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('../../src/utils/haptics', () => ({ tap: jest.fn() }));

describe('ProductOptionsModal', () => {
  const product = {
    _id: 'native-option-product',
    name: 'Tailored overshirt',
    optionGroups: [
      { name: 'Color', values: ['Navy', 'Stone'], default: 'Navy' },
      { name: 'Size', values: ['Small', 'Large'], default: 'Large' },
    ],
  };

  it('requires an active choice for every group before confirming', () => {
    const onConfirm = jest.fn();
    const screen = render(
      <ProductOptionsModal
        visible
        product={product}
        onClose={jest.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText('0 of 2')).toBeTruthy();
    expect(screen.getByText('Complete selections')).toBeTruthy();

    fireEvent.press(screen.getByTestId('confirm-product-options'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('Choose 2 options to continue')).toBeTruthy();

    fireEvent.press(screen.getByTestId('option-value-Color-Navy'));
    fireEvent.press(screen.getByTestId('option-value-Size-Large'));

    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.getByText('Add to cart')).toBeTruthy();
    fireEvent.press(screen.getByTestId('confirm-product-options'));

    expect(onConfirm).toHaveBeenCalledWith({
      selectedColor: 'Navy',
      selectedOptions: { Color: 'Navy', Size: 'Large' },
    });
  });
});
