// API Configuration
// Change this to your backend URL
// For local development on Android emulator: http://10.0.2.2:5000
// For local development on physical device: http://YOUR_LOCAL_IP:5000
// For production: your deployed backend URL

export const API_BASE_URL = 'https://genzwinners-backend.vercel.app';

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
    GET_ALL: '/api/products',
    GET_BY_ID: '/api/products',
    CREATE: '/api/products',
    UPDATE: '/api/products',
    DELETE: '/api/products',
    WISHLIST: '/api/products/get-wishlist',
    ADD_TO_WISHLIST: '/api/products/add-to-wishlist',
    REMOVE_FROM_WISHLIST: '/api/products/delete-from-wishlist',
    BULK_DISCOUNT: '/api/products/bulk-discount',
    REMOVE_DISCOUNT: '/api/products/remove-discount',
  },
  ORDERS: {
    GET_ALL: '/api/orders',
    GET_BY_ID: '/api/orders',
    CREATE: '/api/orders',
    UPDATE: '/api/orders',
  },
  STORES: {
    GET_ALL: '/api/stores',
    GET_BY_SLUG: '/api/stores',
    TRUST: '/api/stores', // POST /:storeId/trust
    UNTRUST: '/api/stores', // DELETE /:storeId/trust
    TRUST_STATUS: '/api/stores', // GET /:storeId/trust-status
    TRUSTED_STORES: '/api/stores/trusted',
    VERIFY: '/api/stores', // POST /:storeId/verify
    UNVERIFY: '/api/stores', // POST /:storeId/unverify
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
  },
  CART: {
    GET: '/api/cart/get',
    ADD: '/api/cart/add',
    REMOVE: '/api/cart/remove',
    QTY_INC: '/api/cart/qty-inc',
    QTY_DEC: '/api/cart/qty-dec',
  },
  CURRENCY: {
    GET_RATES: '/api/currency/rates',
  },
};

import axios from 'axios';
import * as SecureStore from 'expo-secure-store';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor to add auth token (reads from SecureStore)
api.interceptors.request.use(
  async (config) => {
    try {
      const token = await SecureStore.getItemAsync('jwtToken');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (error) {
      console.log('Error getting token from SecureStore:', error);
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor — clear token on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      try {
        await SecureStore.deleteItemAsync('jwtToken');
        await SecureStore.deleteItemAsync('currentUser');
      } catch (_) {}
    }
    return Promise.reject(error);
  }
);

export default api;
