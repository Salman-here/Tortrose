import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import CheckoutProgress from '../../src/components/common/CheckoutProgress';
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: {
  colors: { primary: '#6366f1', text: '#172435', textSecondary: '#64748b' },
  glass: { bgSubtle: '#fff', borderSubtle: '#d5ddec' },
} }) }));

test('progress shows exactly Cart, Shipping and Payment without allowing skipped steps', () => {
  const select = jest.fn();
  const screen = render(<CheckoutProgress currentStep={0} onStepPress={select} />);
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getByRole('tab', { name: 'Step 1 of 3, Cart' }).props.accessibilityState.selected).toBe(true);
  fireEvent.press(screen.getByRole('tab', { name: 'Step 3 of 3, Payment' }));
  expect(select).not.toHaveBeenCalled();
});

test('reviewed steps can be revisited without submitting anything; busy payment locks navigation', () => {
  const select = jest.fn();
  const screen = render(<CheckoutProgress currentStep={2} onStepPress={select} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Step 2 of 3, Shipping' }));
  expect(select).toHaveBeenCalledWith(1);
  screen.rerender(<CheckoutProgress currentStep={2} onStepPress={select} disabled />);
  select.mockClear();
  fireEvent.press(screen.getByRole('tab', { name: 'Step 1 of 3, Cart' }));
  expect(select).not.toHaveBeenCalled();
});
