import { getOrderTotal } from './orderItems.js';

export const SUPPORTED_RECEIPT_CURRENCIES = Object.freeze(['USD', 'PKR', 'EUR', 'GBP']);
const supportedReceiptCurrencies = new Set(SUPPORTED_RECEIPT_CURRENCIES);

/**
 * Format an immutable transaction receipt in its persisted denomination.
 * This intentionally has no selected-currency or FX fallback: invalid legacy
 * data returns null so the UI can disclose that the amount is unavailable.
 */
export function formatPersistedOrderReceipt(order) {
  const currency = typeof order?.currency === 'string'
    ? order.currency.trim().toUpperCase()
    : '';
  if (!supportedReceiptCurrencies.has(currency)) return null;

  let amount;
  try {
    amount = getOrderTotal(order);
  } catch {
    return null;
  }

  return `${currency} ${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(amount)}`;
}

/**
 * NotificationsPage receives full-order totals only in its admin outlet.
 * Seller receipts must come from the seller-scoped durable outbox copy; never
 * guess provenance from similarly named fields such as `_originalTotal`.
 */
export function formatSyntheticPaidOrderReceipt(order, dashboardRole) {
  if (dashboardRole !== 'admin') return null;
  return formatPersistedOrderReceipt(order);
}
