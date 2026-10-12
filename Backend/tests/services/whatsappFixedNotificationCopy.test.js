'use strict';

const fs = require('node:fs');
const path = require('node:path');
const buyer = require('../../services/whatsapp/messageBuilder');
const seller = require('../../services/whatsapp/sellerMessageTemplates');

const order = (stores = ['Atlas Aura']) => ({
  orderId: 'ORD-COPY', currency: 'PKR', paymentMethod: 'cash_on_delivery',
  shippingInfo: { fullName: 'Sam Buyer', city: 'Example City' },
  orderItems: stores.map(storeName => ({ name: 'Travel mug', storeName, quantity: 1, price: 100, lineSubtotal: 100 })),
  orderSummary: { subtotal: stores.length * 100, shippingCost: 0, couponDiscount: 0, tax: 0, totalAmount: stores.length * 100 },
});

test.each([['single seller', ['Atlas Aura']], ['multiple sellers', ['Atlas Aura', 'Luna Lane']]])(
  'buyer confirmation copy is accurate for %s without assuming packing has started', (_label, stores) => {
    const snapshot = order(stores);
    const payload = buyer.buildOrderButtonsPayload(snapshot);
    expect(payload.description).toContain('Please confirm your cash on delivery order.');
    expect(payload.description).toContain('Confirm order or Cancel order');
    expect(payload.footer).toBe('Cash on delivery · Confirmation required');
    expect(payload.buttons.map(button => button.id)).toEqual(['confirm_ORD-COPY', 'cancel_ORD-COPY']);
    const paid = buyer.buildOrderPlacedInfoMessage({ ...snapshot, paymentMethod: 'safepay' });
    expect(paid).toContain('Your payment is confirmed.');
    expect(paid).toContain('updates as your items are prepared and shipped');
    expect(paid).not.toMatch(/each seller|packing.*now|prepare only|payment provider|frozen/i);
    for (const storeName of stores) expect(payload.description).toContain(storeName);
  }
);

test('seller utility copy uses seller actions, not internal scope instructions or untrusted block reasons', () => {
  expect(seller.order_confirmed(order())).toContain('Open the order in your seller dashboard');
  expect(seller.return_requested({ returnNumber: 'RET-COPY', orderId: 'ORD-COPY' }))
    .toContain('Returns tab in Order Management');
  expect(seller.return_settled({ returnNumber: 'RET-COPY', orderId: 'ORD-COPY' }, 'Rs100.00 PKR'))
    .not.toMatch(/allocated|settlement|frozen/);
  expect(seller.subscription_ending_soon(1)).not.toMatch(/update.*payment method|automatic/i);
  expect(seller.account_blocked('raw offensive provider response')).not.toContain('raw offensive provider response');
  expect(seller.payment_recovered()).not.toMatch(/good standing|store is.*live/i);
});

test('fixed assistant connection URLs point to actual registered web routes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../services/whatsapp/whatsappAIChatService.js'), 'utf8');
  const routes = fs.readFileSync(path.resolve(__dirname, '../../../Frontend/src/routes/AppRoutes.jsx'), 'utf8');
  for (const route of ['/user-dashboard/whatsapp', '/seller-dashboard/whatsapp-settings', '/become-seller']) {
    expect(source).toContain(route);
    expect(routes).toContain(`path='${route}'`);
  }
  expect(source).not.toContain('/user-dashboard/whatsapp-ai');
  expect(source).not.toContain('Done. I processed that, but');
  expect(source).toContain('Check the relevant page in Rozare before retrying an order or payment action.');
});

test('order messages do not require an account for guest tracking and cancellation guidance stays accurate', () => {
  const guest = buyer.buildOrderPlacedInfoMessage({ ...order(), paymentMethod: 'safepay', user: null });
  expect(guest).toContain('https://rozare.com/track-order');
  expect(guest).not.toContain('your Rozare account');
  const { getBuyerCancellationBlock } = require('../../services/orderFulfillmentService');
  const paid = getBuyerCancellationBlock({ isPaid: true, orderStatus: 'confirmed' });
  expect(paid.code).toBe('PAID_ORDER_REQUIRES_REFUND');
  expect(paid.message).toContain('review cancellation and refund options before shipment');
  expect(paid.message).toContain('For guest orders');
  const shipped = getBuyerCancellationBlock({ isPaid: true, orderStatus: 'shipped' });
  expect(shipped.code).toBe('ORDER_FULFILLMENT_STARTED');
  expect(shipped.message).toContain('check any unshipped items');
});
