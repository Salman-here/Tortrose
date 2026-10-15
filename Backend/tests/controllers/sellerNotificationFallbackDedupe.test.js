'use strict';
require('../helpers/retainedStripeTestMode')();
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Notification = require('../../models/Notification');
const { getSellerNotifications } = require('../../controllers/analyticsController');
let database;
beforeAll(async () => { database = await MongoMemoryServer.create(); await mongoose.connect(database.getUri()); }, 60000);
afterEach(async () => { await Promise.all([Order.deleteMany({}), Product.deleteMany({}), Notification.deleteMany({})]); });
afterAll(async () => { await mongoose.disconnect(); await database.stop(); });
const read = async seller => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await getSellerNotifications({ user: { id: String(seller), role: 'seller' }, query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(200);
  return res.json.mock.calls[0][0].notifications;
};
async function fixture({ paid = false, pending = false } = {}) {
  const seller = new mongoose.Types.ObjectId();
  const product = await Product.create({ seller, name: 'Variant mug', price: 10, currency: 'USD', priceCurrency: 'USD', stock: 5, category: 'Home', brand: 'QA', image: 'https://example.com/mug.png' });
  const confirmedAt = pending ? null : new Date();
  const status = pending ? 'pending' : 'confirmed';
  const order = await Order.create({ user: new mongoose.Types.ObjectId(), orderId: 'QA-' + new mongoose.Types.ObjectId(),
    currency: 'USD', paymentMethod: paid ? 'stripe' : 'cash_on_delivery', isPaid: paid, paidAt: paid ? new Date() : null,
    orderStatus: status, awaitingPayment: false,
    orderItems: [{ productId: product._id, seller, name: product.name, image: product.image, price: 10, quantity: 2 }],
    sellerFulfillment: [{ seller, status }], shippingInfo: { fullName: 'QA Buyer', email: 'qa@example.com', phone: '+923001234567', address: 'QA Street', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
    shippingMethod: { name: 'Free', price: 0, estimatedDays: 3 }, orderSummary: { subtotal: 20, shippingCost: 0, tax: 0, totalAmount: 20 },
    sellerSettlementVersion: paid ? 1 : 0, sellerSettlement: paid ? [{ seller, sourceCurrency: 'USD', sourceAmountMinor: 2000, amountUSDMinor: 2000 }] : [],
    confirmation: { confirmedAt, confirmedVia: confirmedAt ? 'email' : null },
  });
  return { seller, product, order, confirmedAt };
}
const persist = (f, type, { user = f.seller, role = 'seller', read = false, at = f.confirmedAt } = {}) => {
  const decision = type.replace(/^order\./, '');
  const eventKey = ['confirmed', 'reconfirmed'].includes(decision)
    ? `order:${f.order._id}:decision:${crypto.createHash('sha256').update(`${decision}:${at.toISOString()}`).digest('hex')}:seller:${f.seller}:v1`
    : `order:${f.order._id}:${decision}:seller:${f.seller}:v1`;
  return Notification.create({ user, title: 'Stored seller update', body: 'Verified durable event.', category: 'order', targetRole: role,
    source: 'system', aggregateType: 'Order', aggregateId: String(f.order._id), eventType: type, eventKey, read });
};
test.each([false, true])('a durable COD confirmation suppresses its synthetic duplicate, including read=%s', async readState => {
  const f = await fixture(); const stored = await persist(f, 'order.confirmed', { read: readState });
  expect((await read(f.seller)).some(row => row.id === `confirmed-${f.order._id}`)).toBe(false);
  expect((await Notification.findById(stored._id).lean()).read).toBe(readState);
  expect(await Notification.countDocuments()).toBe(1);
});
test('legacy confirmation fallback remains and names the shared confirmation link accurately', async () => {
  const f = await fixture(); const rows = await read(f.seller);
  expect(rows.find(row => row.id === `confirmed-${f.order._id}`).title).toContain('via confirmation link');
  expect(rows.some(row => row.id === `low-${f.product._id}`)).toBe(true);
});
test.each(['other-seller', 'buyer-audience'])('a %s receipt cannot hide this seller confirmation', async mismatch => {
  const f = await fixture(); await persist(f, 'order.confirmed', mismatch === 'other-seller' ? { user: new mongoose.Types.ObjectId() } : { role: 'user' });
  expect((await read(f.seller)).some(row => row.id === `confirmed-${f.order._id}`)).toBe(true);
});
test('an older confirmation does not suppress a new confirmation whose durable delivery is pending', async () => {
  const f = await fixture(); await persist(f, 'order.confirmed', { at: new Date(f.confirmedAt.getTime() - 60000) });
  expect((await read(f.seller)).some(row => row.id === `confirmed-${f.order._id}`)).toBe(true);
});
test('a distinct paid event does not suppress a COD confirmation', async () => {
  const f = await fixture(); await persist(f, 'order.paid');
  expect((await read(f.seller)).some(row => row.id === `confirmed-${f.order._id}`)).toBe(true);
});
test('a durable placement suppresses only the new-order fallback, retaining live stock warnings', async () => {
  const f = await fixture({ pending: true });
  expect((await read(f.seller)).some(row => row.id === `order-${f.order._id}`)).toBe(true);
  await persist(f, 'order.placed'); const rows = await read(f.seller);
  expect(rows.some(row => row.id === `order-${f.order._id}`)).toBe(false);
  expect(rows.some(row => row.id === `low-${f.product._id}`)).toBe(true);
});
test('a durable payment suppresses the duplicate paid fallback without changing frozen money', async () => {
  const f = await fixture({ paid: true }); const before = await Order.findById(f.order._id).lean();
  expect((await read(f.seller)).some(row => row.id === `paid-${f.order._id}`)).toBe(true);
  await persist(f, 'order.paid');
  expect((await read(f.seller)).some(row => row.id === `paid-${f.order._id}`)).toBe(false);
  expect(await Order.findById(f.order._id).lean()).toEqual(before);
});
