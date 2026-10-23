'use strict';

const { formatItemOptionsText } = require('../../utils/orderPresentation');

// Names/options are display-only checkout snapshots, never template syntax,
// links, live product lookups, or a source from which to recalculate money.
const inlineBuyerText = (value, limit = 120) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
  .replace(/https?:\/\/\S+/gi, '')
  .replace(/[*_~`{}]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, limit);

const buyerGreeting = order => {
  const firstName = inlineBuyerText(order?.shippingInfo?.fullName, 100).split(' ')[0];
  return `Hey ${firstName || 'there'}! 👋`;
};

// Only order-owned snapshots are used here. Looking up a live Store/Product
// would change a past receipt when a seller renames or deletes their store.
const buyerOrderStoreNames = order => {
  const sellerKey = value => String(value?._id || value || '');
  const items = Array.isArray(order?.orderItems) ? order.orderItems : [];
  const sellers = new Set(items.map(item => sellerKey(item?.seller)).filter(Boolean));
  const names = [], knownSellers = new Set();
  const add = value => {
    const name = typeof value === 'string' ? inlineBuyerText(value, 120) : '';
    if (name && !names.includes(name)) names.push(name);
    return Boolean(name);
  };
  for (const policy of order?.sellerPolicies || []) {
    const seller = sellerKey(policy?.seller);
    if ((!sellers.size || sellers.has(seller)) && add(policy?.storeName)) knownSellers.add(seller);
  }
  for (const item of items) {
    if (!knownSellers.has(sellerKey(item?.seller))) add(item?.storeName || item?.store?.storeName);
  }
  return names;
};

const buyerStoresLine = names => {
  const values = [...new Set((Array.isArray(names) ? names : []).map(name => inlineBuyerText(name, 120)).filter(Boolean))];
  if (!values.length) return '';
  // Leave room for items, exact money and the action link within WhatsApp's
  // durable message limit, even for a large multi-store checkout.
  const visible = values.slice(0, 30);
  const nameLimit = Math.max(8, Math.min(120, Math.floor((900 - 2 * visible.length) / visible.length)));
  const labels = visible.map(name => name.length > nameLimit ? `${name.slice(0, nameLimit - 1)}…` : name);
  const more = values.length > visible.length ? `, …and ${values.length - visible.length} more stores` : '';
  return `${values.length === 1 ? 'Store' : 'Stores'}: ${labels.join(', ')}${more}`;
};
const buyerOrderStoresLine = order => buyerStoresLine(buyerOrderStoreNames(order));

const buyerProductSummary = items => {
  const lines = Array.isArray(items) ? items : [];
  const visible = lines.slice(0, 4).map(item => {
    const name = inlineBuyerText(item?.name) || 'Order item';
    const options = inlineBuyerText(formatItemOptionsText(item), 130);
    const quantity = Number.isSafeInteger(item?.quantity) && item.quantity > 0 ? ` ×${item.quantity}` : '';
    return `• ${name}${options ? ` (${options})` : ''}${quantity}`;
  });
  if (lines.length > visible.length) visible.push(`…and ${lines.length - visible.length} more item${lines.length - visible.length === 1 ? '' : 's'}`);
  return visible.join('\n');
};

const buyerOrderMessage = (order, {
  orderNumber = order?.orderId,
  headline,
  detail,
  moneyLine,
  items = order?.orderItems,
  storeName = '',
  storeNames = [],
  shippingSummary = '',
} = {}) => [
  buyerGreeting(order),
  `*${headline}*`,
  [`Order: #${inlineBuyerText(orderNumber, 100)}`, storeName ? `Store: ${inlineBuyerText(storeName, 100)}` : buyerStoresLine(storeNames)].filter(Boolean).join('\n'),
  buyerProductSummary(items),
  [moneyLine, shippingSummary ? inlineBuyerText(shippingSummary, 240) : ''].filter(Boolean).join('\n'),
  detail,
  order?.user ? 'Track it anytime in your Rozare account. 🩵' : 'Track your order anytime on Rozare. 🩵',
].filter(Boolean).join('\n\n');

module.exports = { inlineBuyerText, buyerGreeting, buyerProductSummary, buyerOrderMessage, buyerOrderStoreNames, buyerOrderStoresLine };
