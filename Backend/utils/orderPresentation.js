const { formatMoneySync, normalizeCurrency } = require('../services/currencyService');

const toPlainOptions = (value) => {
  if (!value) return {};
  if (typeof value.toJSON === 'function') return toPlainOptions(value.toJSON());
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value === 'object') return { ...value };
  return {};
};

const clean = (value) => String(value ?? '').trim();

const getOrderCurrency = (order, fallback = 'USD') =>
  normalizeCurrency(order?.currency || order?.displayCurrency || order?.orderCurrency || fallback);

const formatOrderMoney = (amount, orderOrCurrency = 'USD') => {
  const currency = typeof orderOrCurrency === 'string'
    ? normalizeCurrency(orderOrCurrency)
    : getOrderCurrency(orderOrCurrency);
  return formatMoneySync(Number(amount) || 0, currency, { sourceCurrency: currency });
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
  const qty = Number(item.quantity || item.qty || 1) || 1;
  const total = (Number(item.price) || 0) * qty;
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
  formatOrderMoney,
  orderItemVariantPairs,
  formatItemOptionsText,
  orderItemName,
  orderItemLineText,
  orderItemOptionsHtml,
  escapeHtml,
  paymentMethodLabel,
};
