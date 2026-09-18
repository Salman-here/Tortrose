'use strict';
// Read-only release evidence. No model initialization, writes or token output.
const path = require('path');
const mongoose = require('../Backend/node_modules/mongoose');
require('../Backend/node_modules/dotenv').config({ path: path.resolve(__dirname, '../Backend/.env'), quiet: true });
// Scope alternate DNS resolution to this diagnostic process, not Windows.
if (process.env.CURRENCY_AUDIT_PUBLIC_DNS === '1') require('dns').setServers(['1.1.1.1', '8.8.8.8']);
const ids = process.argv.slice(2);
if (!ids.length || ids.length > 15 || ids.some(id => !/^ORD-\d+$/.test(id))) throw new Error('Supply 1–15 exact test order references.');
(async () => {
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000, readPreference: 'primary' });
  const db = mongoose.connection.db;
  const seller = await db.collection('users').findOne({ email: 'rzais90501@mailinator.com' }, { projection: { _id: 1 } });
  const buyer = await db.collection('users').findOne({ email: 'rzaib90501@mailinator.com' }, { projection: { _id: 1 } });
  if (!seller || !buyer) throw new Error('The expected dedicated test accounts were not found.');
  const orders = await db.collection('orders').find({ orderId: { $in: ids }, user: buyer._id }, { projection: {
    orderId: 1, currency: 1, orderSummary: 1, exchangeRateSnapshot: 1, sellerCurrencyMoneyVersion: 1,
    sellerCurrencyMoney: 1, sellerFulfillment: 1, paymentMethod: 1, isPaid: 1, orderStatus: 1,
    'orderItems.productId': 1, 'orderItems.seller': 1, 'orderItems.name': 1, 'orderItems.price': 1,
    'orderItems.quantity': 1, 'orderItems.sourcePrice': 1, 'orderItems.sourceCurrency': 1,
    'orderItems.selectedOptions': 1, 'orderItems.selectedColor': 1,
  } }).toArray();
  if (orders.length !== ids.length) throw new Error('One or more exact test orders were not found for the expected buyer.');
  const store = await db.collection('stores').findOne({ seller: seller._id }, { projection: { storeName: 1, productCurrency: 1, productCurrencyStatus: 1, lastProductCurrencyChangeAt: 1 } });
  const products = await db.collection('products').find({ seller: seller._id }, { projection: { name: 1, price: 1, discountedPrice: 1, currency: 1, stock: 1 } }).toArray();
  const shipping = await db.collection('shippingmethods').findOne({ seller: seller._id }, { projection: { methods: 1 } });
  const coupons = await db.collection('coupons').find({ seller: seller._id }, { projection: { code: 1, discountType: 1, discountValue: 1, currency: 1, minOrderAmount: 1, maxDiscountAmount: 1, isActive: 1, usedCount: 1, startDate: 1, expiryDate: 1 } }).toArray();
  console.log(JSON.stringify({ store, products, shipping, coupons, orders }, null, 2));
})().catch(error => { console.error('Read-only currency audit failed:', JSON.stringify({ code:error.code, name:error.name, syscall:error.syscall })); process.exitCode = 1; }).finally(() => mongoose.disconnect());
