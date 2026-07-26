import { Platform } from 'react-native';

let cachedNotifications;

export function isAndroidExpoGo() {
  if (Platform.OS !== 'android') return false;

  try {
    const { isRunningInExpoGo } = require('expo');
    return typeof isRunningInExpoGo === 'function' && isRunningInExpoGo();
  } catch {
    return false;
  }
}

/**
 * Remote Android push notifications are unavailable in Expo Go from SDK 53.
 * Avoid loading expo-notifications there so Expo Go does not emit a native
 * remote-notification error while the rest of the app is being developed.
 * Development and release builds still receive the real module.
 */
export function getNotificationsModule() {
  if (isAndroidExpoGo()) return null;
  if (!cachedNotifications) cachedNotifications = require('expo-notifications');
  return cachedNotifications;
}
