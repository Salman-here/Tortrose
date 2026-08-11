// Jest setup file

// Mock AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(() => Promise.resolve({ isConnected: true, isInternetReachable: true })),
  },
}));

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// Mock Expo native modules that are safe to no-op in unit/property tests.
jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  cancelAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve()),
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  setBadgeCountAsync: jest.fn(() => Promise.resolve()),
  setNotificationHandler: jest.fn(),
}));

jest.mock('expo-crypto', () => {
  let sequence = 0;
  return {
    getRandomBytesAsync: jest.fn(async length => {
      sequence += 1;
      return Uint8Array.from(
        { length },
        (_, index) => (index * 17 + 29 + sequence) % 256
      );
    }),
    randomUUID: jest.fn(() => '00000000-0000-4000-8000-000000000001'),
  };
});

jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(() => Promise.resolve({ canceled: true, assets: null })),
}));

jest.mock('@stripe/stripe-react-native', () => ({
  StripeProvider: ({ children }) => children,
  initStripe: jest.fn(() => Promise.resolve()),
  useStripe: jest.fn(() => ({
    initPaymentSheet: jest.fn(() => Promise.resolve({})),
    presentPaymentSheet: jest.fn(() => Promise.resolve({})),
  })),
  PaymentSheetError: { Canceled: 'Canceled', Failed: 'Failed', Timeout: 'Timeout' },
}));

jest.mock('expo-audio', () => ({
  RecordingPresets: { LOW_QUALITY: {}, HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  useAudioRecorder: jest.fn(() => ({
    uri: null,
    record: jest.fn(),
    stop: jest.fn(() => Promise.resolve()),
    prepareToRecordAsync: jest.fn(() => Promise.resolve()),
    getStatus: jest.fn(() => ({ url: null })),
  })),
  useAudioRecorderState: jest.fn(() => ({ isRecording: false, durationMillis: 0 })),
}));

// The keyboard controller is a native module. Unit tests exercise the form
// composition, so use React Native primitives while preserving refs/props.
jest.mock('react-native-keyboard-controller', () => {
  const React = require('react');
  const { ScrollView, View } = require('react-native');

  return {
    KeyboardProvider: ({ children }) => React.createElement(View, null, children),
    KeyboardStickyView: ({ children, ...props }) => React.createElement(View, props, children),
    KeyboardAwareScrollView: React.forwardRef((props, ref) => (
      React.createElement(ScrollView, { ...props, ref })
    )),
  };
});

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
  create: jest.fn(() => ({
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    interceptors: {
      request: { use: jest.fn() },
      response: { use: jest.fn() },
    },
  })),
}));

// Mock navigation
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    replace: jest.fn(),
  }),
  useRoute: () => ({
    params: {},
  }),
}));

// Silence console warnings during tests
global.console = {
  ...console,
  warn: jest.fn(),
  error: jest.fn(),
};
