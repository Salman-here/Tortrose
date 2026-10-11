'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Product = require('../../models/Product');
const Cart = require('../../models/Cart');
const { executeToolCall } = require('../../services/aiActionExecutor');
let replica, buyer, atlas, nova, atlasProduct, novaProduct;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  buyer = await User.create({ username: 'cart buyer', email: 'scopebuyer@example.com', password: 'testing123', role: 'user', currency: 'USD' });
  atlas = await User.create({ username: 'atlas seller', email: 'atlas@example.com', password: 'testing123', role: 'seller', status: 'active' });
  nova = await User.create({ username: 'nova seller', email: 'nova@example.com', password: 'testing123', role: 'seller', status: 'active' });
  await Store.create([{ seller: atlas._id, storeName: 'Atlas Aura Goods', storeSlug: 'atlas-aura-goods', isActive: true },
    { seller: nova._id, storeName: 'Nova Nest', storeSlug: 'nova-nest', isActive: true }]);
  const fields = { name: 'Minimalist Wallet', price: 10, currency: 'USD', category: 'Fashion', brand: 'QA', stock: 10, image: 'https://example.com/product.jpg' };
  atlasProduct = await Product.create({ ...fields, seller: atlas._id });
  novaProduct = await Product.create({ ...fields, seller: nova._id });
}, 120000);
beforeEach(async () => { await Cart.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
const actor = () => ({ id: buyer._id, role: 'user', currency: 'USD' });
test('friendly product names resolve inside the explicitly named store', async () => {
  const result = await executeToolCall('add_to_cart', { productName: 'Minimalist Wallet', storeName: 'Atlas Aura Goods', quantity: 1 }, actor());
  expect(result.success).toBe(true);
  const cart = await Cart.findOne({ user: buyer._id }).lean();
  expect(cart.cartItems).toHaveLength(1);
  expect(String(cart.cartItems[0].product)).toBe(String(atlasProduct._id));
});
test('a supplied product id cannot override the buyer selected store', async () => {
  const result = await executeToolCall('add_to_cart', { productId: String(novaProduct._id), storeSlug: 'atlas-aura-goods', quantity: 1 }, actor());
  expect(result).toMatchObject({ success: false, code: 'CART_STORE_MISMATCH' });
  expect(await Cart.countDocuments({ user: buyer._id })).toBe(0);
});
test('an unknown product option is still rejected rather than silently dropped', async () => {
  const result = await executeToolCall('add_to_cart', { productId: String(atlasProduct._id), storeName: 'Atlas Aura Goods', selectedOptions: { Store: 'Atlas Aura Goods' } }, actor());
  expect(result).toMatchObject({ success: false, needsSelection: true });
  expect(await Cart.countDocuments({ user: buyer._id })).toBe(0);
});
test('an unavailable store never falls back to a similarly named product elsewhere', async () => {
  const result = await executeToolCall('add_to_cart', { productId: String(atlasProduct._id), storeName: 'Missing Store' }, actor());
  expect(result).toMatchObject({ success: false, needsStoreSelection: true });
  expect(await Cart.countDocuments({ user: buyer._id })).toBe(0);
});
test('a genuinely declared variant group named Store is preserved', async () => {
  await Product.updateOne({ _id: atlasProduct._id }, { $set: { optionGroups: [{ name: 'Store', values: ['Main', 'Outlet'] }] } });
  try {
    const result = await executeToolCall('add_to_cart', { productId: String(atlasProduct._id), storeName: 'Atlas Aura Goods', selectedOptions: { Store: 'Main' }, _lastUserText: 'Choose Main for the Store option.' }, actor());
    expect(result.success).toBe(true);
    const cart = await Cart.findOne({ user: buyer._id }).lean();
    expect(cart.cartItems[0].selectedOptions).toEqual({ Store: 'Main' });
  } finally { await Product.updateOne({ _id: atlasProduct._id }, { $set: { optionGroups: [] } }); }
});
