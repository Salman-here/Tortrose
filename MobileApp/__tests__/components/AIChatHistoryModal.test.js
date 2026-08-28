import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AIChatHistoryModal from '../../src/components/common/AIChatHistoryModal';

jest.mock('../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        primary: '#6366F1',
        primaryLighter: '#C7D2FE',
        primarySubtle: '#EEF2FF',
        secondarySubtle: '#F5F3FF',
        success: '#10B981',
        successSubtle: '#ECFDF5',
        error: '#EF4444',
        errorLighter: '#FEE2E2',
        errorSubtle: '#FEF2F2',
        grayLighter: '#D1D5DB',
        surface: '#FFFFFF',
        overlay: 'rgba(0,0,0,0.5)',
        text: '#1F2937',
        textSecondary: '#6B7280',
        textLight: '#9CA3AF',
      },
      glass: {
        bgStrong: 'rgba(255,255,255,0.60)',
        bgSubtle: 'rgba(255,255,255,0.18)',
        border: 'rgba(255,255,255,0.50)',
        borderStrong: 'rgba(255,255,255,0.65)',
        borderSubtle: 'rgba(255,255,255,0.25)',
      },
      gradients: { cta: ['#14B8A6', '#0EA5E9', '#6366F1'] },
    },
  }),
}));

jest.mock('../../src/components/common/GlassBlurFill', () => {
  const ReactNative = require('react-native');
  return function MockGlassBlurFill() {
    return <ReactNative.View />;
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

describe('AIChatHistoryModal', () => {
  const conversations = [
    {
      _id: 'chat-order',
      title: 'Order help',
      preview: 'Your parcel is on the way',
      messageCount: 2,
      lastActive: new Date().toISOString(),
      source: 'mobile',
    },
    {
      _id: 'chat-style',
      title: 'Style ideas',
      preview: 'A navy outfit for dinner',
      messageCount: 6,
      lastActive: new Date(Date.now() - 86400000).toISOString(),
      source: 'web',
    },
  ];

  it('supports selecting, searching, creating, renaming, and deleting conversations', async () => {
    const onSelect = jest.fn();
    const onCreate = jest.fn();
    const onRename = jest.fn().mockResolvedValue(true);
    const onDelete = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const screen = render(
      <AIChatHistoryModal
        visible
        conversations={conversations}
        activeConversationId="chat-order"
        onClose={jest.fn()}
        onRefresh={jest.fn()}
        onSelect={onSelect}
        onCreate={onCreate}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByText('Chat history')).toBeTruthy();
    expect(screen.getByText('Order help')).toBeTruthy();
    expect(screen.getByText('Style ideas')).toBeTruthy();

    fireEvent.press(screen.getByTestId('ai-history-item-chat-order'));
    expect(onSelect).toHaveBeenCalledWith('chat-order');

    fireEvent.press(screen.getByTestId('ai-history-new-chat'));
    expect(onCreate).toHaveBeenCalledTimes(1);

    fireEvent.changeText(screen.getByTestId('ai-history-search'), 'navy');
    expect(screen.queryByText('Order help')).toBeNull();
    expect(screen.getByText('Style ideas')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('ai-history-search'), '');

    fireEvent.press(screen.getByTestId('ai-history-rename-chat-order'));
    fireEvent.changeText(screen.getByTestId('ai-history-rename-input-chat-order'), 'Delivery update');
    fireEvent.press(screen.getByTestId('ai-history-save-rename-chat-order'));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('chat-order', 'Delivery update'));

    fireEvent.press(screen.getByTestId('ai-history-delete-chat-style'));
    expect(alertSpy).toHaveBeenCalledWith(
      'Delete this conversation?',
      expect.stringContaining('Style ideas'),
      expect.any(Array),
    );
    const buttons = alertSpy.mock.calls.at(-1)[2];
    buttons.find(button => button.text === 'Delete').onPress();
    expect(onDelete).toHaveBeenCalledWith('chat-style');

    alertSpy.mockRestore();
  });
});
