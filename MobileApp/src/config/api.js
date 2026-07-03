import axios from 'axios';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

// SecureStore is unavailable on web — fall back to AsyncStorage there
const tokenGet = (key) =>
  Platform.OS === 'web' ? AsyncStorage.getItem(key) : SecureStore.getItemAsync(key);
const tokenDel = (key) =>
  Platform.OS === 'web' ? AsyncStorage.removeItem(key) : SecureStore.deleteItemAsync(key);

export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://rozare.up.railway.app').replace(/\/$/, '');

export const API_ENDPOINTS = {
  AUTH: {
    LOGIN: '/api/auth/login',
    SIGNUP: '/api/auth/signup',
    LOGOUT: '/api/auth/logout',
    FORGOT_PASSWORD: '/api/auth/forgot-password',
    RESET_PASSWORD: '/api/auth/reset-password',
    GOOGLE_AUTH: '/api/auth/google',
  },
  PRODUCTS: {
    GET_ALL: '/api/products/get-products',
    GET_SELLER: '/api/products/get-seller-products',
    GET_ADMIN: '/api/products/admin-products',
    GET_BY_ID: '/api/products/get-single-product',
    CREATE: '/api/products/add',
    UPDATE: '/api/products/edit',
    DELETE: '/api/products/delete',
    WISHLIST: '/api/products/get-wishlist',
    ADD_TO_WISHLIST: '/api/products/add-to-wishlist',
    REMOVE_FROM_WISHLIST: '/api/products/delete-from-wishlist',
    BULK_DISCOUNT: '/api/products/bulk-discount',
    BULK_PRICE_UPDATE: '/api/products/bulk-price-update',
    BULK_DELETE: '/api/products/bulk-delete',
    REMOVE_DISCOUNT: '/api/products/remove-discount',
  },
  UPLOAD: {
    PRODUCT_IMAGE: '/api/upload/product-image',
    PROFILE_IMAGE: '/api/upload/profile-image',
  },
  ORDERS: {
    GET_ALL: '/api/order/get',
    MY_ORDERS: '/api/order/user-orders',
    PLACE: '/api/order/place',
  },
  STORES: {
    GET_ALL: '/api/stores',
    GET_ALL_ADMIN: '/api/stores/all',
    MY_STORE: '/api/stores/my-store',
    UPDATE: '/api/stores/update',
    GET_BY_SLUG: '/api/stores',
    TRUSTED_STORES: '/api/stores/trusted',
    PRODUCT_CURRENCY: '/api/stores/product-currency',
    PRODUCT_CURRENCY_CONVERT: '/api/stores/product-currency/convert',
    PRODUCT_CURRENCY_CANCEL: '/api/stores/product-currency/cancel',
  },
  USER: {
    PROFILE: '/api/user/profile',
    UPDATE: '/api/user/update',
    SINGLE: '/api/user/single',
    BECOME_SELLER: '/api/user/become-seller',
    GET_ALL: '/api/user/get',
    BLOCK_TOGGLE: '/api/user/block-toggle',
    ADMIN_TOGGLE: '/api/user/admin-toggle',
    DELETE: '/api/user/delete',
    SHIPPING_INFO: '/api/user/shipping-info',
  },
  CART: {
    GET: '/api/cart/get',
    ADD: '/api/cart/add',
    REMOVE: '/api/cart/remove',
    QTY_INC: '/api/cart/qty-inc',
    QTY_DEC: '/api/cart/qty-dec',
    CLEAR: '/api/cart/clear',
  },
  CURRENCY: {
    GET_RATES: '/api/currency/rates',
    UPDATE: '/api/currency/update',
  },
  PAYMENTS: {
    SELLER_SUMMARY: '/api/payments/seller/summary',
    SELLER_ACCOUNT: '/api/payments/seller/account',
    SELLER_WITHDRAWALS: '/api/payments/seller/withdrawals',
    ADMIN_OVERVIEW: '/api/payments/admin/overview',
    ADMIN_WITHDRAWAL: '/api/payments/admin/withdrawals',
  },
  SHIPPING: {
    SELLER: '/api/shipping/seller',
    METHODS: '/api/shipping/methods',
    CART: '/api/shipping/cart',
  },
  COUPONS: {
    CREATE: '/api/coupons/create',
    SELLER: '/api/coupons/seller',
    ANALYTICS: '/api/coupons/analytics',
    UPDATE: '/api/coupons/update',
    DELETE: '/api/coupons/delete',
    TOGGLE: '/api/coupons/toggle',
    VALIDATE: '/api/coupons/validate',
    CHECKOUT: '/api/coupons/checkout-coupons',
  },
  USER_WHATSAPP: {
    STATUS: '/api/user-whatsapp/status',
    SEND_OTP: '/api/user-whatsapp/send-otp',
    VERIFY_OTP: '/api/user-whatsapp/verify-otp',
    UNLINK: '/api/user-whatsapp/unlink',
  },
  SELLER_WHATSAPP: {
    PREFS: '/api/seller-whatsapp/prefs',
    SEND_OTP: '/api/seller-whatsapp/send-otp',
    VERIFY_OTP: '/api/seller-whatsapp/verify-otp',
  },
  LOCATIONS: {
    COUNTRIES: '/api/locations/countries',
    STATES: '/api/locations/states',
    CITIES: '/api/locations/cities',
  },
  SUBSCRIPTION: {
    STATUS: '/api/subscription/status',
    CREATE_CHECKOUT: '/api/subscription/create-checkout',
    CANCEL: '/api/subscription/cancel',
  },
  AI_ACTIONS: {
    RATE_LIMIT: '/api/ai-actions/rate-limit',
    RATE_LIMIT_INCREMENT: '/api/ai-actions/rate-limit/increment',
  },
};

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use(
  async (config) => {
    try {
      const token = await tokenGet('jwtToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.log('Error getting token from storage:', error);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      try {
        await tokenDel('jwtToken');
        await tokenDel('currentUser');
      } catch (_) {}
    }
    return Promise.reject(error);
  }
);

export default api;
