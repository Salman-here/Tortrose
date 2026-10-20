import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import NotificationCard from '../../src/components/notifications/NotificationCard';

jest.mock('../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }),
}));
jest.mock('../../src/components/common/GlassPanel', () => {
  const { View } = require('react-native');
  return ({ children, ...props }) => <View {...props}>{children}</View>;
});
jest.mock('../../src/hooks/useNotificationInbox', () => ({ formatTime: () => 'Just now' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

test('notification cards show the complete server-authored body and label subscriptions', () => {
  const item = {
    id: 'preview-notification', category: 'subscription', title: 'Subscription ending soon',
    body: 'Your plan ends on 20 October.\nOpen Subscription to review your available options.',
    createdAt: '2026-10-12T00:00:00.000Z', read: false,
  };
  const onPress = jest.fn();
  const screen = render(<NotificationCard item={item} onPress={onPress} />);
  expect(screen.getByText(item.body).props.numberOfLines).toBeUndefined();
  expect(screen.getByText(item.title).props.numberOfLines).toBeUndefined();
  expect(screen.getByText('Subscription')).toBeTruthy();
  // Repeated inbox surfaces must not allocate native Android blur layers:
  // RenderNode/opacity recycling left tapped rows blank on a real device.
  expect(screen.UNSAFE_getAllByType(require('react-native').View).some(view => view.props.androidBlur === false)).toBe(true);
  fireEvent.press(screen.getByRole('button'));
  expect(onPress).toHaveBeenCalledWith(item);
});
