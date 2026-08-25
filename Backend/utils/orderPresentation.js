const { formatMoneySync, isSupportedCurrency, normalizeCurrency } = require('../services/currencyService');
const { getOrderItemLineSubtotal } = require('../services/orderLinePricingService');
const { roundMoney } = require('../services/moneyMath');

const presentationIntegrityError = label => {
  const error = new Error('The stored ' + label + ' is invalid.');
  error.statusCode = 409;
  error.code = 'ORDER_PRESENTATION_DATA_INVALID';
  return error;
};

const requirePresentationCurrency = (value, label = 'order currency') => {
  if (!isSupportedCurrency(value)) throw presentationIntegrityError(label);
  return normalizeCurrency(value);
};

const requirePresentationMoney = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw presentationIntegrityError(label);
  }
  try {
    if (roundMoney(value) !== value) throw presentationIntegrityError(label);
  } catch (error) {
    if (error?.code === 'ORDER_PRESENTATION_DATA_INVALID') throw error;
    throw presentationIntegrityError(label);
  }
  return value;
};

const toPlainOptions = (value) => {
  if (!value) return {};
  if (typeof value.toJSON === 'function') return toPlainOptions(value.toJSON());
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value === 'object') return { ...value };
  return {};
};

const clean = (value) => String(value ?? '').trim();

const getOrderCurrency = (order, fallback = 'USD') => requirePresentationCurrency(
  order?.currency ?? order?.displayCurrency ?? order?.orderCurrency ?? fallback,
);

const formatOrderMoney = (amount, orderOrCurrency = 'USD') => {
  const currency = typeof orderOrCurrency === 'string'
    ? requirePresentationCurrency(orderOrCurrency)
    : getOrderCurrency(orderOrCurrency);
  return formatMoneySync(
    requirePresentationMoney(amount, 'order money amount'),
    currency,
    { sourceCurrency: currency },
  );
};

// Payment notifications must render the exact persisted accounting total and
// currency. In particular, do not use `||` here: zero is valid, while a stored
// blank value is corruption that the strict formatter must surface.
const formatPaidOrderNotificationTotal = order => {
  const currency = requirePresentationCurrency(order?.currency, 'order currency');
  return formatOrderMoney(order?.orderSummary?.totalAmount, currency);
};

const formatOrderItemUnitMoney = (item = {}, orderOrCurrency = 'USD') => {
  const orderCurrency = typeof orderOrCurrency === 'string'
    ? requirePresentationCurrency(orderOrCurrency)
    : getOrderCurrency(orderOrCurrency);
  const rawSourcePrice = item.sourcePrice ?? item.priceOriginal;
  const sourcePrice = rawSourcePrice === null || rawSourcePrice === undefined
    ? null
    : requirePresentationMoney(rawSourcePrice, 'seller source price');
  // Null/absent metadata is legacy and may inherit the order currency. A
  // present blank/unsupported value is stored corruption and must not be
  // hidden by `||` fallback semantics.
  const rawSourceCurrency = item.sourceCurrency ?? item.priceCurrency;
  const sourceCurrency = rawSourceCurrency !== null && rawSourceCurrency !== undefined
    ? requirePresentationCurrency(rawSourceCurrency, 'seller source currency')
    : orderCurrency;
  if (
    rawSourcePrice !== null
    && rawSourcePrice !== undefined
    && sourcePrice !== null
    && sourceCurrency !== orderCurrency
  ) {
    return `${formatMoneySync(sourcePrice, sourceCurrency, { sourceCurrency })} seller price`;
  }
  return formatOrderMoney(item.price, orderCurrency);
};

const orderItemVariantPairs = (item = {}) => {
  const pairs = [];
  const selectedOptions = toPlainOptions(item.selectedOptions);

  Object.entries(selectedOptions).forEach(([name, value]) => {
    const key = clean(name);
    const val = clean(value);
    if (key && val) pairs.push({ name: key, value: val });
  });

  const selectedColor = clean(item.selectedColor);
  const hasColorOption = pairs.some(pair => pair.name.toLowerCase() === 'color');
  if (selectedColor && !hasColorOption) {
    pairs.push({ name: 'Color', value: selectedColor });
  }

  return pairs;
};

const formatItemOptionsText = (item = {}) =>
  orderItemVariantPairs(item)
    .map(pair => `${pair.name}: ${pair.value}`)
    .join(', ');

const orderItemName = (item = {}) =>
  clean(item.name || item.productId?.name || item.product?.name || 'Item') || 'Item';

const orderItemLineText = (item = {}, orderOrCurrency = 'USD') => {
  const qty = item.quantity;
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw presentationIntegrityError('order item quantity');
  }
  // Spreading a Mongoose subdocument copies its internal fields, not its
  // schema getters. Pass the accounting fields explicitly so notifications
  // retain the persisted authoritative subtotal.
  const total = getOrderItemLineSubtotal({
    price: item.price,
    lineSubtotal: item.lineSubtotal,
    quantity: qty,
  });
  const variants = formatItemOptionsText(item);
  return `${orderItemName(item)}${variants ? ` (${variants})` : ''} x${qty} - ${formatOrderMoney(total, orderOrCurrency)}`;
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const orderItemOptionsHtml = (item = {}) => {
  const text = formatItemOptionsText(item);
  if (!text) return '';
  return `<br/><span style="color:#64748b;font-size:12px;">${escapeHtml(text)}</span>`;
};

const paymentMethodLabel = (method) => {
  if (method === 'cash_on_delivery') return 'Cash on Delivery';
  if (method === 'stripe') return 'Card (Stripe)';
  if (method === 'wallet') return 'Rozare Wallet';
  return method || 'Unknown';
};

module.exports = {
  toPlainOptions,
  getOrderCurrency,
  requirePresentationMoney,
  formatOrderMoney,
  formatPaidOrderNotificationTotal,
  formatOrderItemUnitMoney,
  orderItemVariantPairs,
  formatItemOptionsText,
  orderItemName,
  orderItemLineSubtotal: getOrderItemLineSubtotal,
  orderItemLineText,
  orderItemOptionsHtml,
  escapeHtml,
  paymentMethodLabel,
};
