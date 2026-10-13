import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import NotificationSearchField from '../../src/components/notifications/NotificationSearchField';
import { notificationMatchesSearch } from '../../src/utils/notificationSearch';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));

test('matches buyer and seller message fields, ignoring case and surrounding spaces', () => {
  expect(notificationMatchesSearch({ title: 'Order delivered', description: 'Travel Mug' }, ' MUG ')).toBe(true);
  expect(notificationMatchesSearch({ title: 'Payment received', body: 'Rs100.00 PKR' }, 'pkr')).toBe(true);
  expect(notificationMatchesSearch({ title: 'Order delivered' }, 'withdrawal')).toBe(false);
  expect(notificationMatchesSearch({}, ' ')).toBe(true);
  expect(notificationMatchesSearch({ body: null }, 'card')).toBe(false);
});

test('controlled typing and clear remain separate from the search icon and perform no navigation', () => {
  const onChangeText = jest.fn();
  const screen = render(<NotificationSearchField value="order" onChangeText={onChangeText} />);
  fireEvent.changeText(screen.getByLabelText('Search notifications'), 'refund');
  expect(onChangeText).toHaveBeenCalledWith('refund');
  fireEvent.press(screen.getByLabelText('Clear notification search'));
  expect(onChangeText).toHaveBeenCalledWith('');
});
