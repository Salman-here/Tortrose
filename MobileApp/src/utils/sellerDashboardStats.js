import { currencyCodeIsSupported, roundCurrencyAmount } from './currencySafety';
import {
  getOrderCurrency,
  getOrderItemCount,
  getOrderItemLineSubtotal,
  getOrderSummaryAmount,
  getOrderTotal,
} from './orderPresentation';

const ORDER_STATUSES = new Set(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']);
const PAYMENT_METHODS = new Set(['stripe', 'wallet', 'cash_on_delivery']);

const hasOwn = (value, key) => Boolean(value)
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key);

const statusOf = (order) => {
  const stored = ['orderStatus', 'status']
    .filter((key) => hasOwn(order, key))
    .map((key) => order[key])
    .filter((value) => value !== null && value !== undefined);
  const unique = [...new Set(stored)];
  return unique.length === 1 && ORDER_STATUSES.has(unique[0]) ? unique[0] : null;
};

const hasStoredMoney = (summary, keys) => keys.some((key) => (
  hasOwn(summary, key) && summary[key] !== null && summary[key] !== undefined
));

export const sellerInventorySnapshotIsValid = (products) => (
  Array.isArray(products)
  && products.every((product) => (
    product
    && typeof product === 'object'
    && Number.isSafeInteger(product.stock)
    && product.stock >= 0
  ))
);

export const readSellerProductRating = (product) => {
  const stored = ['rating', 'averageRating']
    .filter((key) => hasOwn(product, key))
    .map((key) => product[key])
    .filter((value) => value !== null && value !== undefined);
  if (
    stored.length === 0
    || stored.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5)
    || new Set(stored).size > 1
  ) return null;
  return stored[0];
};

export const sellerStoreInventorySnapshotIsValid = (products) => (
  sellerInventorySnapshotIsValid(products)
  && products.every((product) => (
    typeof product?._id === 'string'
    && /^[a-f\d]{24}$/i.test(product._id)
    && typeof product.name === 'string'
    && product.name.trim().length > 0
    && typeof product.category === 'string'
    && product.category.trim().length > 0
    && typeof product.isFeatured === 'boolean'
    && readSellerProductRating(product) !== null
  ))
);

export const readNonNegativePresentationCount = (value) => (
  Number.isSafeInteger(value) && value >= 0 ? value : null
);

export const sellerOrderPresentationIsValid = (order) => {
  if (
    !order
    || typeof order !== 'object'
    || !statusOf(order)
    || !PAYMENT_METHODS.has(order.paymentMethod)
    || typeof order.isPaid !== 'boolean'
    || !Array.isArray(order.orderItems)
    || order.orderItems.length === 0
    || !order.orderSummary
    || typeof order.orderSummary !== 'object'
  ) return false;
  const summary = order.orderSummary;
  if (![
    ['subtotal'],
    ['shippingCost', 'shippingFee'],
    ['tax', 'taxAmount'],
    ['couponDiscount', 'discountAmount'],
    ['totalAmount', 'total'],
  ].every((keys) => hasStoredMoney(summary, keys))) return false;
  try {
    getOrderCurrency(order);
    getOrderItemCount(order);
    order.orderItems.forEach(getOrderItemLineSubtotal);
    getOrderSummaryAmount(order, ['subtotal'], 'seller order subtotal');
    getOrderSummaryAmount(order, ['shippingCost', 'shippingFee'], 'seller order shipping');
    getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'seller order tax');
    getOrderSummaryAmount(order, ['couponDiscount', 'discountAmount'], 'seller order discount');
    getOrderTotal(order);
    return true;
  } catch (_error) {
    return false;
  }
};

export const sellerOrdersSnapshotIsValid = (orders) => (
  Array.isArray(orders)
  && orders.every(sellerOrderPresentationIsValid)
  && orders.every((order) => typeof order._id === 'string' && order._id.trim().length > 0)
  && new Set(orders.map((order) => order._id)).size === orders.length
);

export const selectAuthoritativeSellerMetrics = (metrics, targetCurrency = 'USD') => {
  const responseCurrency = String(metrics?.currency || '').trim().toUpperCase();
  const requestedCurrency = String(targetCurrency || 'USD').trim().toUpperCase();
  const totalSales = metrics?.totalSales;
  const totalOrders = metrics?.totalOrders;
  const valid = currencyCodeIsSupported(responseCurrency)
    && currencyCodeIsSupported(requestedCurrency)
    && responseCurrency === requestedCurrency
    && typeof totalSales === 'number'
    && Number.isFinite(totalSales)
    && totalSales >= 0
    && roundCurrencyAmount(totalSales) === totalSales
    && Number.isSafeInteger(totalOrders)
    && totalOrders >= 0
    && (totalOrders > 0 || totalSales === 0);
  return valid ? { totalSales, totalOrders } : null;
};

export const selectAuthoritativeSellerRevenue = (metrics, targetCurrency = 'USD') => (
  selectAuthoritativeSellerMetrics(metrics, targetCurrency)?.totalSales ?? null
);

export const selectAuthoritativeSellerOrderCount = (metrics, targetCurrency = 'USD') => (
  selectAuthoritativeSellerMetrics(metrics, targetCurrency)?.totalOrders ?? null
);

export const isRecognizedSellerOrder = (order) => {
  const status = statusOf(order);
  if (!status || status === 'cancelled' || !PAYMENT_METHODS.has(order?.paymentMethod)) return false;

  const paymentMethod = order.paymentMethod;
  if (paymentMethod === 'cash_on_delivery') return status === 'delivered';
  if (paymentMethod === 'stripe' || paymentMethod === 'wallet') return order.isPaid === true;
  return false;
};

export const calculateSellerStats = (
  products,
  orders
) => {
  if (
    !sellerInventorySnapshotIsValid(products)
    || !Array.isArray(orders)
    || !orders.every((order) => statusOf(order) !== null)
  ) return null;
  const totalProducts = products.length;
  const totalOrders = orders.length;
  const pendingOrders = orders.filter((order) => statusOf(order) === 'pending').length;
  const processingOrders = orders.filter((order) => statusOf(order) === 'processing').length;
  const deliveredOrders = orders.filter((order) => statusOf(order) === 'delivered').length;
  const outOfStock = products.filter((product) => product.stock === 0).length;
  const lowStock = products.filter((product) => product.stock > 0 && product.stock <= 10).length;

  const conversion = totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0;

  return {
    totalProducts,
    totalOrders,
    pendingOrders,
    processingOrders,
    deliveredOrders,
    outOfStock,
    lowStock,
    conversion,
  };
};
