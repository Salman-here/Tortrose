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
  shippingSummary = '',
} = {}) => [
  buyerGreeting(order),
  `*${headline}*`,
  [`Order: #${inlineBuyerText(orderNumber, 100)}`, storeName ? `Store: ${inlineBuyerText(storeName, 100)}` : ''].filter(Boolean).join('\n'),
  buyerProductSummary(items),
  [moneyLine, shippingSummary ? inlineBuyerText(shippingSummary, 240) : ''].filter(Boolean).join('\n'),
  detail,
  order?.user ? 'Track it anytime in your Rozare account. 🩵' : 'Track your order anytime on Rozare. 🩵',
].filter(Boolean).join('\n\n');

module.exports = { inlineBuyerText, buyerGreeting, buyerProductSummary, buyerOrderMessage };
