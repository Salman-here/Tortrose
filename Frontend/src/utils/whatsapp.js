import {
  formatOrderItemOptions,
  getOrderCurrency,
  getOrderItemLineSubtotal,
  getOrderItemQuantity,
  getOrderTotal,
} from './orderItems.js';
import { currencyCodeIsSupported, roundCurrencyAmount } from './currencySafety.js';

/**
 * WhatsApp order verification helper.
 * Generates a wa.me link with a pre-filled verification message.
 *
 * Accepts any of:
 *   "+923028588506" (E.164 from PhoneField)
 *   "923028588506"  (already international digits)
 *   "03028588506"   (domestic — requires the order's country calling code)
 *   "3028588506"    (domestic, no leading 0 — also requires a calling code)
 * Always returns a wa.me-safe digit string with country code, or '' if invalid.
 */

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

export const sanitizePhone = (rawPhone, countryCallingCode = '') => {
  if (!rawPhone) return '';
  const raw = String(rawPhone).trim();
  const explicitInternational = raw.startsWith('+') || /^00\d/.test(raw);
  let digits = digitsOnly(raw);
  if (!digits) return '';

  if (/^00\d/.test(raw)) digits = digits.replace(/^00/, '');
  if (explicitInternational) return digits.length >= 8 && digits.length <= 15 ? digits : '';

  // A number longer than an ordinary domestic subscriber number is assumed
  // to already contain its country code. Never silently prepend Pakistan's
  // code to an international buyer just because a seller is in Pakistan.
  if (!raw.startsWith('0') && digits.length > 10) {
    return digits.length <= 15 ? digits : '';
  }

  const callingCode = digitsOnly(countryCallingCode);
  const local = digits.replace(/^0+/, '');
  if (!callingCode || !local) return '';
  const international = `${callingCode}${local}`;
  return international.length >= 8 && international.length <= 15 ? international : '';
};

const orderCallingCode = (order) => (
  order?.shippingInfo?.phonecode
  || order?.shippingInfo?.phoneCode
  || order?.buyerLocation?.phonecode
  || order?.buyerLocation?.phoneCode
  || ''
);

const formatMoney = (n, formatPrice, sourceCurrency) => {
  const amount = n;
  const currency = sourceCurrency;
  if (
    typeof amount !== 'number'
    || !Number.isFinite(amount)
    || amount < 0
    || roundCurrencyAmount(amount) !== amount
    || typeof currency !== 'string'
    || currency !== currency.trim().toUpperCase()
    || !currencyCodeIsSupported(currency)
  ) {
    const error = new Error('The stored order money cannot be represented safely.');
    error.code = 'ORDER_PRESENTATION_DATA_INVALID';
    throw error;
  }
  if (typeof formatPrice === 'function') {
    return formatPrice(amount, {
      sourceCurrency: currency,
      targetCurrency: currency,
      showCode: true,
    });
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

export const buildVerifyMessage = (order, formatPrice) => {
  const currency = getOrderCurrency(order);
  const fullName = order?.shippingInfo?.fullName || 'Customer';
  const storeName =
    order?.orderItems?.[0]?.product?.store?.storeName ||
    order?.orderItems?.[0]?.store?.storeName ||
    'our store';
  const orderId = order?.orderId || order?._id?.slice(-8)?.toUpperCase() || '';

  const lines = (order?.orderItems || []).map((it) => {
    const name = it?.product?.name || it?.name || 'Item';
    const qty = getOrderItemQuantity(it);
    const price = formatMoney(getOrderItemLineSubtotal(it), formatPrice, currency);
    const options = formatOrderItemOptions(it);
    return `- ${name}${options ? ` (${options})` : ''} x${qty} - ${price}`;
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

export const openWhatsAppVerify = (order, formatPrice) => {
  const phone = sanitizePhone(order?.shippingInfo?.phone, orderCallingCode(order));
  if (!phone) return false;
  let text;
  try {
    text = encodeURIComponent(buildVerifyMessage(order, formatPrice));
  } catch (error) {
    console.error('Cannot build WhatsApp verification from invalid order money:', error);
    return false;
  }
  const url = `https://wa.me/${phone}?text=${text}`;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
};

export const hasWhatsAppPhone = (order) =>
  Boolean(sanitizePhone(order?.shippingInfo?.phone, orderCallingCode(order)));

// True if buyer already self-confirmed the order by any channel — means
// the manual "Verify on WhatsApp" button is no longer needed.
export const isOrderConfirmedByBuyer = (order) =>
  Boolean(order?.confirmation?.confirmedAt);

// True if the buyer has made ANY decision (confirmed OR cancelled).
// Use this for showing the confirmation-source badge on seller/admin views.
export const isOrderDecidedByBuyer = (order) =>
  Boolean(order?.confirmation?.confirmedAt || order?.confirmation?.declinedAt);

// True specifically when the Rozare WhatsApp poll/reply flow finalised the order.
export const isOrderHandledByWhatsAppAutomation = (order) =>
  Boolean(
    order?.confirmation?.confirmedVia === 'whatsapp' &&
    (order?.confirmation?.confirmedAt || order?.confirmation?.declinedAt)
  );

// Human-friendly label for the source badge shown on admin/seller order rows.
// Returns '' when nothing should be displayed.
export const getConfirmationSourceLabel = (order) => {
  if (!order?.confirmation) return '';
  const confirmation = order.confirmation;
  const via = confirmation.decidedVia || confirmation.confirmedVia;
  const confirmed = !!confirmation.confirmedAt;
  const declined = !!confirmation.declinedAt;
  const cancelled = order.orderStatus === 'cancelled'
    || !!confirmation.cancelledAt
    || declined
    || !!confirmation.cancelledFromDashboardAt;
  const cancellationActor = confirmation.cancelledByRole;

  if (cancelled && confirmed) {
    const note = confirmation.cancelledFromDashboardNote || '';
    const legacyVia = note.includes('account') || note.includes('dashboard')
      ? 'dashboard'
      : 'email';
    const cancellationVia = confirmation.cancelledVia || legacyVia;
    const confirmedChannel = confirmation.confirmedVia === 'whatsapp'
      ? 'WhatsApp'
      : (confirmation.confirmedVia === 'email' ? 'email' : confirmation.confirmedVia || 'Rozare');
    if (cancellationActor === 'admin') {
      return `Cancelled by administrator (was confirmed by buyer via ${confirmedChannel})`;
    }
    if (cancellationActor === 'seller') {
      return `Cancelled by seller (was confirmed by buyer via ${confirmedChannel})`;
    }
    if (cancellationActor === 'system') {
      return `Cancelled automatically by Rozare (was confirmed by buyer via ${confirmedChannel})`;
    }
    const buyerSource = cancellationVia === 'dashboard'
      ? 'from account'
      : `via ${cancellationVia === 'whatsapp' ? 'Rozare WhatsApp automation' : cancellationVia}`;
    return `Cancelled by buyer ${buyerSource} (was confirmed via ${confirmedChannel})`;
  }

  if (cancelled) {
    if (cancellationActor === 'admin') return 'Cancelled by administrator';
    if (cancellationActor === 'seller') return 'Cancelled by seller';
    if (cancellationActor === 'system') return 'Cancelled automatically by Rozare';
  }
  if (!via || (!confirmed && !declined)) return '';
  const action = confirmed ? 'Confirmed' : 'Cancelled';
  if (via === 'whatsapp') return `${action} by buyer via Rozare WhatsApp automation`;
  if (via === 'email') return `${action} by buyer via email link`;
  if (via === 'manual') return `${action} manually by seller`;
  if (via === 'admin') return `${action} by admin`;
  if (via === 'dashboard') return `${action} by buyer from account`;
  return `${action} by buyer`;
};
