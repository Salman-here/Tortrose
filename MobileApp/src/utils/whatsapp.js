/**
 * Seller WhatsApp order verification helpers.
 *
 * Domestic numbers are resolved with the order's actual destination country.
 * We never silently assume one country for every Rozare seller.
 */

import { Alert, Linking } from 'react-native';
import api from '../config/api';
import {
  formatOrderItemOptions,
  getOrderCurrency,
  getOrderItemLineSubtotal,
  getOrderItemQuantity,
  getOrderTotal,
} from './orderPresentation';
import { currencyCodeIsSupported, roundCurrencyAmount } from './currencySafety';

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

export const sanitizePhone = (rawPhone, countryCallingCode = '') => {
  if (!rawPhone) return '';
  const raw = String(rawPhone).trim();
  const explicitInternational = raw.startsWith('+') || /^00\d/.test(raw);
  let digits = digitsOnly(raw);
  if (!digits) return '';

  if (/^00\d/.test(raw)) digits = digits.replace(/^00/, '');
  if (explicitInternational) return digits.length >= 8 && digits.length <= 15 ? digits : '';

  // A number longer than a normal domestic subscriber number is assumed to
  // already include its country code. Short/local numbers need a known code.
  if (!raw.startsWith('0') && digits.length > 10) {
    return digits.length <= 15 ? digits : '';
  }

  const callingCode = digitsOnly(countryCallingCode);
  const local = digits.replace(/^0+/, '');
  if (!callingCode || !local) return '';
  const international = `${callingCode}${local}`;
  return international.length >= 8 && international.length <= 15 ? international : '';
};

const formatMoney = (amount, formatPrice, sourceCurrency) => {
  if (
    typeof amount !== 'number'
    || !Number.isFinite(amount)
    || amount < 0
    || roundCurrencyAmount(amount) !== amount
    || typeof sourceCurrency !== 'string'
    || sourceCurrency !== sourceCurrency.trim().toUpperCase()
    || !currencyCodeIsSupported(sourceCurrency)
  ) {
    const error = new Error('The stored order money cannot be represented safely.');
    error.code = 'ORDER_PRESENTATION_DATA_INVALID';
    throw error;
  }
  if (typeof formatPrice === 'function') {
    return formatPrice(amount, {
      sourceCurrency,
      targetCurrency: sourceCurrency,
      showCode: true,
    });
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: sourceCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch (_) {
    return `${sourceCurrency} ${amount.toFixed(2)}`;
  }
};

export const buildVerifyMessage = (order, formatPrice) => {
  const fullName = order?.shippingInfo?.fullName || 'Customer';
  const storeName = order?.store?.storeName
    || order?.orderItems?.[0]?.product?.store?.storeName
    || order?.orderItems?.[0]?.store?.storeName
    || 'our store';
  const orderId = order?.orderId || String(order?._id || '').slice(-8).toUpperCase();
  const currency = getOrderCurrency(order);

  const lines = (order?.orderItems || []).map((item) => {
    const name = item?.product?.name || item?.productId?.name || item?.name || 'Item';
    const quantity = getOrderItemQuantity(item);
    const options = formatOrderItemOptions(item);
    const total = formatMoney(getOrderItemLineSubtotal(item), formatPrice, currency);
    return `- ${name}${options ? ` (${options})` : ''} x${quantity} - ${total}`;
  });

  const total = getOrderTotal(order);

  return [
    `Hello ${fullName}, this is ${storeName} on Rozare.`,
    '',
    `We're verifying your order #${orderId}:`,
    ...lines,
    '',
    `Total: ${formatMoney(total, formatPrice, currency)}`,
    '',
    'Please reply YES to confirm, or let us know if anything needs to change. Thank you!',
  ].join('\n');
};

async function resolveCallingCode(order) {
  const shipping = order?.shippingInfo || {};
  const storedCode = shipping.phonecode
    || shipping.phoneCode
    || order?.buyerLocation?.phonecode
    || order?.buyerLocation?.phoneCode;
  if (storedCode) return storedCode;

  const country = shipping.countryCode || order?.buyerLocation?.countryCode || shipping.country;
  if (!country) return '';

  try {
    const response = await api.get('/api/locations/countries', {
      params: { q: country, limit: 5 },
    });
    const countries = response?.data?.countries || [];
    const normalized = String(country).trim().toLowerCase();
    const match = countries.find((item) => (
      String(item?.isoCode || '').toLowerCase() === normalized
      || String(item?.name || '').toLowerCase() === normalized
    )) || countries[0];
    return match?.phonecode || '';
  } catch (_) {
    return '';
  }
}

export const openWhatsAppVerify = async (order, formatPrice) => {
  const rawPhone = order?.shippingInfo?.phone;
  const callingCode = await resolveCallingCode(order);
  const phone = sanitizePhone(rawPhone, callingCode);
  if (!phone) {
    Alert.alert(
      rawPhone ? 'Country code needed' : 'No phone number',
      rawPhone
        ? 'This phone number is not in international format and its country code could not be resolved. Add the country code before contacting the buyer.'
        : 'This order has no phone number on file.',
    );
    return false;
  }

  let text;
  try {
    text = encodeURIComponent(buildVerifyMessage(order, formatPrice));
  } catch (_) {
    Alert.alert(
      'Order total unavailable',
      'This order contains invalid money data and cannot be sent for verification. Refresh it or contact support.',
    );
    return false;
  }
  const appUrl = `whatsapp://send?phone=${phone}&text=${text}`;
  const webUrl = `https://wa.me/${phone}?text=${text}`;

  try {
    const supported = await Linking.canOpenURL(appUrl);
    await Linking.openURL(supported ? appUrl : webUrl);
    return true;
  } catch (_) {
    try {
      await Linking.openURL(webUrl);
      return true;
    } catch (error) {
      Alert.alert('Unable to open WhatsApp', 'Please make sure WhatsApp is installed.');
      return false;
    }
  }
};

export const hasWhatsAppPhone = (order) => Boolean(digitsOnly(order?.shippingInfo?.phone));

export const isOrderConfirmedByBuyer = (order) => Boolean(order?.confirmation?.confirmedAt);

export const isOrderDecidedByBuyer = (order) => Boolean(
  order?.confirmation?.confirmedAt || order?.confirmation?.declinedAt,
);

export const isOrderHandledByWhatsAppAutomation = (order) => Boolean(
  order?.confirmation?.confirmedVia === 'whatsapp'
  && (order?.confirmation?.confirmedAt || order?.confirmation?.declinedAt),
);

export const getConfirmationSourceLabel = (order) => {
  const confirmation = order?.confirmation;
  if (!confirmation) return '';

  const via = confirmation.decidedVia || confirmation.confirmedVia;
  const confirmed = Boolean(confirmation.confirmedAt);
  const declined = Boolean(confirmation.declinedAt);
  const cancelledFromDashboard = Boolean(confirmation.cancelledFromDashboardAt);

  if (cancelledFromDashboard && confirmed) {
    const note = confirmation.cancelledFromDashboardNote || '';
    const cancelledFrom = /account|dashboard/i.test(note) ? 'account' : 'email';
    const confirmedChannel = via === 'whatsapp' ? 'WhatsApp' : (via === 'email' ? 'email' : via || 'buyer');
    return `Cancelled by buyer from ${cancelledFrom} (was confirmed via ${confirmedChannel})`;
  }

  if (!via || (!confirmed && !declined)) return '';
  const action = confirmed ? 'Confirmed' : 'Cancelled';
  const channels = {
    whatsapp: 'by buyer via Rozare WhatsApp automation',
    email: 'by buyer via email link',
    manual: 'manually by seller',
    admin: 'by admin',
    dashboard: 'by buyer from account',
  };
  return `${action} ${channels[via] || 'by buyer'}`;
};
