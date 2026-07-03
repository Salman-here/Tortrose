/**
 * secureStorage — SecureStore on native, AsyncStorage fallback on web.
 * Use for the auth token and other small secrets so flows work on Expo web too.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const isWeb = Platform.OS === 'web';

export const secureSet = (key, value) =>
  isWeb ? AsyncStorage.setItem(key, value) : SecureStore.setItemAsync(key, value);

export const secureGet = (key) =>
  isWeb ? AsyncStorage.getItem(key) : SecureStore.getItemAsync(key);

export const secureDel = (key) =>
  isWeb ? AsyncStorage.removeItem(key) : SecureStore.deleteItemAsync(key);
