import axios from 'axios';
import { getAuthToken } from './cookieHelper';
import { validateSafepayCheckout, validateSafepayPayment } from './safepayContract';

export const safepayApi = axios.create({ baseURL: `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api/safepay`, timeout: 20000 });
safepayApi.interceptors.request.use(config => {
  config.headers.Authorization = `Bearer ${getAuthToken()}`;
  return config;
});
let presenter = null;
export const registerSafepayPresenter = next => { presenter = next; return () => { if (presenter === next) presenter = null; }; };
export const verifySafepayPayment = async expected => validateSafepayPayment(
  (await safepayApi.get(`/payments/${expected.paymentId}`)).data, expected,
);
export const openSafepayCheckout = async response => {
  const payment = validateSafepayCheckout(response);
  if (payment.status !== 'pending') return verifySafepayPayment(payment);
  if (!presenter) throw Object.assign(new Error('Secure payment screen is unavailable. Refresh and retry the same attempt.'), { retainMutationAttempt: true });
  return presenter(payment);
};
