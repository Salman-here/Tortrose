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
  await Store.create([{ seller: atlas._id, storeName: 'Atlas Aura Goods', storeSlug: 'atlas-aura-goods', productCurrency: 'USD', isActive: true },
    { seller: nova._id, storeName: 'Nova Nest', storeSlug: 'nova-nest', productCurrency: 'USD', isActive: true }]);
  const fields = { name: 'Minimalist Wallet', price: 10, currency: 'USD', priceCurrency: 'USD', priceInputAmount: 10,
    discountedPriceCurrency: 'USD', discountedPriceInputAmount: 0, priceVersion: 2,
    category: 'Fashion', brand: 'QA', stock: 10, image: 'https://example.com/product.jpg' };
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
test('AI product policy writes enable custom returns and preserve unrelated fields on a partial edit', async () => {
  const seller = { id: atlas._id, role: 'seller', currency: 'USD' };
  let result = await executeToolCall('edit_product', { productId: String(atlasProduct._id), updates: { returnPolicy: { returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' } } }, seller);
  if (!result.success) throw new Error(result.error || result.message || 'Policy write failed');
  expect(result).toMatchObject({ success: true });
  expect((await Product.findById(atlasProduct._id).lean()).returnPolicy).toMatchObject({ useStorePolicy: false, returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' });
  result = await executeToolCall('edit_product', { productId: String(atlasProduct._id), updates: { returnPolicy: { returnDuration: 14 } } }, seller);
  expect(result.success).toBe(true);
  const stored = await Product.findById(atlasProduct._id).lean();
  expect(stored.returnPolicy).toMatchObject({ useStorePolicy: false, returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' });
  expect(stored.price).toBe(10); expect(stored.stock).toBe(10);
});
test('public product details distinguish effective inherited terms from inactive custom fields', async () => {
  const base = { seller: atlas._id, name: 'Policy readback item', price: 10, currency: 'USD', priceCurrency: 'USD',
    discountedPriceCurrency: 'USD', category: 'Fashion', brand: 'QA', stock: 5, image: 'https://example.com/public-policy.jpg' };
  const inherited = await Product.create({ ...base, returnPolicy: { useStorePolicy: true, returnsEnabled: true, returnDuration: 7, refundType: 'full_refund' } });
  let detail = await executeToolCall('get_product_detail', { productId: String(inherited._id) }, actor());
  expect(detail).toMatchObject({ success: true, data: { effectiveReturnPolicy: { returnsEnabled: false, returnDuration: 0 } } });
  const custom = await Product.create({ ...base, name: 'Custom policy item', returnPolicy: { useStorePolicy: false, returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' } });
  detail = await executeToolCall('get_product_detail', { productId: String(custom._id) }, actor());
  expect(detail).toMatchObject({ success: true, data: { effectiveReturnPolicy: { returnsEnabled: true, returnDuration: 14, refundType: 'full_refund' } } });
});
