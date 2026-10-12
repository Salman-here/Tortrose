/**
 * Email HTML templates for order-related notifications.
 */

const brandColor = '#4f46e5';
const { outboundNotificationUrl, renderTransactionalEmail, trustedRozareUrl } = require('./transactionalEmail');

const {
  escapeHtml,
  formatOrderMoney,
  getOrderCurrency,
  orderItemLineSubtotal,
  orderItemName,
  orderItemOptionsHtml,
  paymentMethodLabel,
} = require('./orderPresentation');

const frontendUrl = () => {
  const configured = trustedRozareUrl(process.env.FRONTEND_URL || 'https://rozare.com');
  return configured ? new URL(configured).origin : 'https://rozare.com';
};

const wrapper = (content) => renderTransactionalEmail({ body: content, preheader: 'A personal update from Rozare' });

const orderMoneyForEmail = (order) => {
  const currency = getOrderCurrency(order);
  return (amount) => formatOrderMoney(amount, currency);
};

const renderEmailItemRows = (order) => {
  const money = orderMoneyForEmail(order);
  return (order.orderItems || []).map(item => {
    if (!Number.isSafeInteger(item?.quantity) || item.quantity < 1) {
      const error = new Error('The stored order item quantity is invalid.');
      error.code = 'ORDER_PRESENTATION_DATA_INVALID';
      error.statusCode = 409;
      throw error;
    }
    return `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;">
        <strong style="color:#1e293b;">${escapeHtml(orderItemName(item))}</strong>${orderItemOptionsHtml(item)}<br/>
        <span style="color:#94a3b8;font-size:13px;">Qty: ${item.quantity}</span>
      </td>
      <td style="padding:9px 0;border-bottom:1px solid #f1f5f9;text-align:right;color:#1e293b;font-weight:600;">${money(orderItemLineSubtotal(item))}</td>
    </tr>
  `;
  }).join('');
};

const renderOrderSummaryRows = (order, { includeDiscount = true } = {}) => {
  const money = orderMoneyForEmail(order);
  const summary = order.orderSummary || {};
  // Format every persisted component even when it is zero. Otherwise a blank,
  // non-finite, or sub-cent tax/discount could disappear from the message
  // while a superficially valid total is still sent to the buyer or seller.
  const subtotalText = money(summary.subtotal);
  const shippingText = money(summary.shippingCost);
  const taxText = money(summary.tax);
  const discountText = money(summary.couponDiscount);
  const totalText = money(summary.totalAmount);
  return `
    <tr><td style="padding:4px 0;color:#64748b;">Subtotal</td><td style="text-align:right;color:#1e293b;">${subtotalText}</td></tr>
    <tr><td style="padding:4px 0;color:#64748b;">Shipping</td><td style="text-align:right;color:#1e293b;">${shippingText}</td></tr>
    ${summary.tax > 0 ? `<tr><td style="padding:4px 0;color:#64748b;">Tax</td><td style="text-align:right;color:#1e293b;">${taxText}</td></tr>` : ''}
    ${includeDiscount && summary.couponDiscount > 0 ? `<tr><td style="padding:4px 0;color:#22c55e;">Discount</td><td style="text-align:right;color:#22c55e;">-${discountText}</td></tr>` : ''}
    <tr><td style="padding:8px 0 0;font-weight:700;color:#1e293b;border-top:2px solid #e2e8f0;">Total</td><td style="text-align:right;padding:8px 0 0;font-weight:700;color:${brandColor};font-size:18px;border-top:2px solid #e2e8f0;">${totalText}</td></tr>
  `;
};

const renderItemsTable = (order) => `
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <thead><tr><th style="text-align:left;padding:8px 0;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:13px;">Item</th><th style="text-align:right;padding:8px 0;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:13px;">Total</th></tr></thead>
    <tbody>${renderEmailItemRows(order)}</tbody>
  </table>
`;

const shippingAddressHtml = (shippingInfo = {}) => `
  ${escapeHtml(shippingInfo.fullName)}<br/>
  ${escapeHtml(shippingInfo.address)}<br/>
  ${escapeHtml(shippingInfo.city)}, ${escapeHtml(shippingInfo.state)} ${escapeHtml(shippingInfo.postalCode)}<br/>
  ${escapeHtml(shippingInfo.country)}
`;

exports.orderConfirmationEmail = (order) => ({
  subject: `Order Confirmed - ${order.orderId}`,
  html: wrapper(`
    <h2 style="color:#1e293b;margin:0 0 8px;">Order Confirmed</h2>
    <p style="color:#64748b;margin:0 0 24px;">Thank you for your order. Here are your order details:</p>
    <div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;">
      <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Order ID</p>
      <p style="margin:0;color:${brandColor};font-weight:700;font-size:18px;">${escapeHtml(order.orderId)}</p>
    </div>
    ${renderItemsTable(order)}
    <div style="background:#f8fafc;border-radius:12px;padding:16px;">
      <table style="width:100%;">${renderOrderSummaryRows(order)}</table>
    </div>
    <div style="margin-top:24px;">
      <h3 style="color:#1e293b;margin:0 0 8px;font-size:15px;">Shipping To</h3>
      <p style="color:#64748b;margin:0;line-height:1.6;">${shippingAddressHtml(order.shippingInfo)}</p>
    </div>
    <p style="color:#64748b;margin:24px 0 0;font-size:13px;">Payment Method: <strong>${paymentMethodLabel(order.paymentMethod)}</strong></p>
  `),
});

exports.orderStatusUpdateEmail = (order, newStatus) => {
  const statusLabels = {
    confirmed: { label: 'Confirmed', color: '#22c55e', msg: 'Your order is confirmed. You will receive updates as your items are prepared and shipped.' },
    processing: { label: 'Processing', color: '#f59e0b', msg: 'Your order is being prepared. Watch for a shipping update.' },
    shipped: { label: 'Shipped', color: '#3b82f6', msg: 'Your order was marked as shipped. Check your order details for delivery progress.' },
    delivered: { label: 'Delivered', color: '#22c55e', msg: 'Your order was marked as delivered. Check its details for any available return options.' },
    cancelled: { label: 'Cancelled', color: '#ef4444', msg: 'Your order was cancelled. Check its details for any applicable refund update.' },
  };

  const info = statusLabels[newStatus] || {
    label: escapeHtml(newStatus || 'Updated'),
    color: brandColor,
    msg: `Your order status has been updated to ${escapeHtml(newStatus || 'updated')}.`,
  };

  return {
    subject: `Order ${info.label} - ${order.orderId}`,
    html: wrapper(`
      <div style="text-align:center;margin-bottom:24px;">
        <h2 style="color:#1e293b;margin:12px 0 8px;">Order ${info.label}</h2>
        <p style="color:#64748b;margin:0;">${info.msg}</p>
      </div>
      <div style="background:#f8fafc;border-radius:12px;padding:16px;text-align:center;">
        <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Order ID</p>
        <p style="margin:0;color:${brandColor};font-weight:700;font-size:18px;">${escapeHtml(order.orderId)}</p>
        <div style="margin-top:12px;display:inline-block;background:${info.color};color:#fff;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;">${info.label}</div>
      </div>
      <p style="color:#64748b;margin:24px 0 0;font-size:13px;text-align:center;">If you have any questions, please contact our support team.</p>
    `),
  };
};

exports.newOrderSellerEmail = (order, sellerName) => ({
  subject: `New Order Received - ${order.orderId}`,
  html: wrapper(`
    <div style="text-align:center;margin-bottom:24px;">
      <h2 style="color:#1e293b;margin:12px 0 8px;">New Order Received</h2>
      <p style="color:#64748b;margin:0;">Hey ${escapeHtml(sellerName || 'Seller')}, you have a new order.</p>
    </div>
    <div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Order ID</p>
      <p style="margin:0;color:${brandColor};font-weight:700;font-size:18px;">${escapeHtml(order.orderId)}</p>
    </div>
    ${renderItemsTable(order)}
    <div style="background:#f8fafc;border-radius:12px;padding:16px;">
      <table style="width:100%;">${renderOrderSummaryRows(order)}</table>
    </div>
    <div style="margin-top:20px;">
      <h3 style="color:#1e293b;margin:0 0 8px;font-size:15px;">Ship To</h3>
      <p style="color:#64748b;margin:0;line-height:1.6;">${shippingAddressHtml(order.shippingInfo)}</p>
    </div>
    <p style="color:#64748b;margin:20px 0 0;font-size:13px;text-align:center;">Log in to your seller dashboard to manage this order.</p>
  `),
});

exports.sellerAccountCreatedEmail = (userName) => ({
  subject: 'Your Rozare seller account was created',
  html: wrapper(`
    <div style="text-align:center;margin-bottom:24px;">
      <h2 style="color:#1e293b;margin:12px 0 8px;">Welcome, ${escapeHtml(userName)}!</h2>
      <p style="color:#64748b;margin:0 0 24px;">Your seller account was created. Complete your store setup before you start receiving orders. Store visibility depends on your settings, content checks and subscription status.</p>
    </div>
    <div style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px;">
      <h3 style="color:#1e293b;margin:0 0 12px;font-size:15px;">What's Next?</h3>
      <ul style="color:#64748b;margin:0;padding-left:20px;line-height:2;">
        <li>Set up your store from the Seller Dashboard</li>
        <li>Add your first products</li>
        <li>Configure shipping methods</li>
        <li>Review your store visibility and subscription</li>
      </ul>
    </div>
    <div style="text-align:center;">
      <a href="${escapeHtml(`${frontendUrl()}/seller-dashboard`)}" style="display:inline-block;background:#0ea5e9;background-image:linear-gradient(110deg,#14b8a6,#0ea5e9,#6366f1);color:#fff;padding:12px 32px;border-radius:10px;text-decoration:none;font-weight:600;">Continue store setup</a>
    </div>
  `),
});

exports.buyerOrderConfirmationRequestEmail = (order, confirmUrl) => ({
  subject: `Please confirm your order ${order.orderId}`,
  html: wrapper(`
    <h2 style="color:#1e293b;margin:0 0 8px;">Confirm your order</h2>
    <p style="color:#64748b;margin:0 0 24px;">Hi ${escapeHtml(order.shippingInfo?.fullName)}, please confirm you'd like to proceed with your Cash on Delivery order. The link expires in 48 hours.</p>
    <div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Order ID</p>
      <p style="margin:0;color:${brandColor};font-weight:700;font-size:18px;">${escapeHtml(order.orderId)}</p>
    </div>
    ${renderItemsTable(order)}
    <div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;">
      <table style="width:100%;">${renderOrderSummaryRows(order)}</table>
    </div>
    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(`${confirmUrl}?intent=confirm`)}" style="display:inline-block;background:#16a34a;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;margin:0 8px 10px;">Confirm Order</a>
      <a href="${escapeHtml(`${confirmUrl}?intent=cancel`)}" style="display:inline-block;background:#dc2626;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;margin:0 8px 10px;">Cancel Order</a>
    </div>
    <p style="color:#94a3b8;margin:24px 0 0;font-size:12px;text-align:center;">For security, either button opens Rozare's decision page. Email scanners cannot confirm or cancel the order automatically.</p>
  `),
});

exports.sellerOrderConfirmedByBuyerEmail = (order, sellerName) => ({
  subject: `Buyer confirmed order ${order.orderId}`,
  html: wrapper(`
    <div style="text-align:center;margin-bottom:24px;">
      <h2 style="color:#1e293b;margin:12px 0 8px;">Buyer Confirmed Order</h2>
      <p style="color:#64748b;margin:0;">Hi ${escapeHtml(sellerName || 'Seller')}, the buyer confirmed their order.</p>
    </div>
    <div style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 4px;color:#94a3b8;font-size:13px;">Order ID</p>
      <p style="margin:0;color:${brandColor};font-weight:700;font-size:18px;">${escapeHtml(order.orderId)}</p>
      <div style="margin-top:12px;display:inline-block;background:#22c55e;color:#fff;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;">Confirmed by Buyer</div>
    </div>
    ${renderItemsTable(order)}
    <p style="color:#64748b;margin:0;line-height:1.6;">
      <strong style="color:#1e293b;">Customer:</strong> ${escapeHtml(order.shippingInfo?.fullName)}<br/>
      <strong style="color:#1e293b;">Total:</strong> ${orderMoneyForEmail(order)(order.orderSummary?.totalAmount)}<br/>
      ${order.confirmation?.confirmedAt && Number.isFinite(new Date(order.confirmation.confirmedAt).getTime()) ? `<strong style="color:#1e293b;">Confirmed at:</strong> ${escapeHtml(new Date(order.confirmation.confirmedAt).toISOString().replace('T', ' ').slice(0, 16))} UTC` : ''}
    </p>
    <p style="color:#64748b;margin:20px 0 0;font-size:13px;text-align:center;">The order status is now <strong>Confirmed</strong>. You can begin processing it.</p>
  `),
});

exports.welcomeEmail = (userName) => ({
  subject: 'Welcome to Rozare',
  text: `Hello ${String(userName || 'there').replace(/[\r\n\t]+/g, ' ').trim()},\n\nYour Rozare account is ready. Discover products and stores, save your favourites, and follow your orders from your account.\n\nStart shopping: ${frontendUrl()}/products`,
  html: renderTransactionalEmail({ title: 'Welcome to Rozare', preheader: 'Your account is ready. Find your next favourite.',
    body: `<p>Hello ${escapeHtml(userName || 'there')},</p><p>Your Rozare account is ready. Discover products and stores, save your favourites, and follow your orders from your account.</p>`,
    actionUrl: `${frontendUrl()}/products`, actionLabel: 'Start shopping' }),
});

exports.broadcastEmail = (title, body, category, linkTo) => {
  const labelMap = {
    announcement: 'Announcement',
    promo: 'Promotion',
    system: 'System Update',
    order: 'Order update',
    seller: 'Seller update',
  };
  const safeBody = escapeHtml(body).replace(/\n/g, '<br/>');
  const label = labelMap[category] || 'Message';
  const href = outboundNotificationUrl(linkTo);

  return {
    subject: title,
    text: `${title}\n\n${body}${href ? `\n\nView details: ${href}` : ''}`,
    html: renderTransactionalEmail({ title, body: `
      <p style="color:#94a3b8;margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;">${label}</p>
      <p style="color:#64748b;margin:0 0 24px;line-height:1.6;">${safeBody}</p>
    `, actionUrl: href, actionLabel: 'View details' }),
  };
};
