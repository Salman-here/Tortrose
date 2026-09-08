'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/currencyService', () => ({
  ...jest.requireActual('../../services/currencyService'),
  getExchangeRateSnapshot: jest.fn().mockResolvedValue({ rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, fallback: false, source: 'test-live' }),
}));
const Cart = require('../../models/Cart');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const AIActionReceipt = require('../../models/AIActionReceipt');
const { changeAICartItem } = require('../../services/aiCartItemService');
const { executeToolCall } = require('../../services/aiActionExecutor');
const { getExchangeRateSnapshot } = require('../../services/currencyService');

let database;
let buyer;
let seller;
let mug;
let lamp;
let initial;
const read = () => Cart.findOne({ user: buyer._id }).lean();

beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Cart.init(), AIActionReceipt.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
}, 60000);
beforeEach(async () => {
  getExchangeRateSnapshot.mockResolvedValue({ rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, fallback: false, source: 'test-live' });
  buyer = await User.create({ username: 'buyer', email: 'buyer@example.com', currency: 'PKR' });
  seller = await User.create({ username: 'seller', email: 'seller@example.com', role: 'seller', currency: 'PKR' });
  await Store.create({ seller: seller._id, storeName: 'Live Mug Store', storeSlug: 'live-mug-store', isActive: true, productCurrency: 'PKR' });
  mug = await Product.create({ name: 'Aurora Thermal Travel Mug', price: 3664.50, currency: 'PKR', priceCurrency: 'PKR', stock: 20, seller: seller._id,
    category: 'Home', brand: 'Aurora', image: 'https://example.com/mug.png',
    optionGroups: [{ name: 'Color', values: ['Black', 'Silver'], default: 'Black' }, { name: 'Capacity', values: ['350ml', '500ml'], default: '350ml' }],
  });
  lamp = await Product.create({ name: 'Desk Lamp', price: 1000, currency: 'PKR', priceCurrency: 'PKR', stock: 10, seller: seller._id, category: 'Home', brand: 'Aurora', image: 'https://example.com/lamp.png' });
  await Cart.create({ user: buyer._id, cartItems: [
    { product: mug._id, qty: 2, selectedColor: 'Black', selectedOptions: { Color: 'Black', Capacity: '500ml' } },
    { product: lamp._id, qty: 1 },
  ] });
  initial = await read();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([Cart.deleteMany({}), Product.deleteMany({}), Store.deleteMany({}), User.deleteMany({}), AIActionReceipt.deleteMany({})]);
});

test('changes only the requested color and preserves quantity, capacity, other products and exact money', async () => {
  const result = await changeAICartItem(buyer._id, { cartItemId: String(initial.cartItems[0]._id), selectedColor: 'Silver' });
  expect(result.success).toBe(true);
  const saved = await read();
  expect(saved.cartItems).toHaveLength(2);
  expect(saved.cartItems[0]).toMatchObject({ qty: 2, selectedColor: 'Silver', selectedOptions: { Color: 'Silver', Capacity: '500ml' } });
  expect(saved.cartItems[1]).toEqual(initial.cartItems[1]);
  expect(saved.totalCartPrice).toBe(8329);
  expect(saved.totalCartCurrency).toBe('PKR');
  expect(result.data.item.quantity).toBe(2);
  expect(result.data.totalQuantity).toBe(3);
});

test('supports partial names and partial option changes without resetting other choices', async () => {
  const result = await changeAICartItem(buyer._id, { productName: 'travel mug', selectedOptions: { color: 'silver' }, quantity: 1 });
  expect(result.success).toBe(true);
  expect((await read()).cartItems[0]).toMatchObject({ qty: 1, selectedColor: 'Silver', selectedOptions: { Color: 'Silver', Capacity: '500ml' } });
  expect(result.data.totalCartPrice).toBe(4664.5);
});

test.each([0, -1, 1.5, true, '', '2', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid absolute quantity %p without any cart write', async quantity => {
  const result = await changeAICartItem(buyer._id, { productId: String(mug._id), quantity });
  expect(result.success).toBe(false);
  expect(await read()).toEqual(initial);
});

test.each([
  { selectedColor: 'Purple' },
  { selectedOptions: { Capacity: '750ml' } },
  { selectedOptions: { Finish: 'Gold' } },
  { selectedColor: 'Black', selectedOptions: { Color: 'Silver' } },
  { selectedOptions: [] },
])('invalid or conflicting options leave the existing item intact: %p', async changes => {
  expect((await changeAICartItem(buyer._id, { productId: String(mug._id), ...changes })).success).toBe(false);
  expect(await read()).toEqual(initial);
});

test('multiple existing variants require a target; a chosen variant merges with an identical destination while preserving units', async () => {
  await Cart.updateOne({ user: buyer._id }, { $push: { cartItems: { product: mug._id, qty: 1, selectedColor: 'Silver', selectedOptions: { Color: 'Silver', Capacity: '500ml' } } } });
  const before = await read();
  const ambiguous = await changeAICartItem(buyer._id, { productName: 'mug', selectedColor: 'Silver' });
  expect(ambiguous.needsCartItemSelection).toBe(true);
  expect(await read()).toEqual(before);
  const result = await changeAICartItem(buyer._id, { productName: 'mug', currentColor: 'Black', selectedColor: 'Silver' });
  expect(result.success).toBe(true);
  const saved = await read();
  expect(saved.cartItems).toHaveLength(2);
  expect(saved.cartItems[0]).toMatchObject({ qty: 3, selectedColor: 'Silver' });
  expect(saved.cartItems[1]).toEqual(initial.cartItems[1]);
});

test('validates aggregate stock across different variants', async () => {
  await Product.updateOne({ _id: mug._id }, { $set: { stock: 3 } });
  await Cart.updateOne({ user: buyer._id }, { $push: { cartItems: { product: mug._id, qty: 1, selectedColor: 'Silver', selectedOptions: { Color: 'Silver', Capacity: '350ml' } } } });
  const before = await read();
  const result = await changeAICartItem(buyer._id, { cartItemId: String(initial.cartItems[0]._id), quantity: 3 });
  expect(result.success).toBe(false);
  expect(result.error).toContain('Only 3 units');
  expect(await read()).toEqual(before);
});

test('a concurrent edit from another cart client is preserved and returns a retryable conflict', async () => {
  const realUpdate = Cart.updateOne.bind(Cart);
  jest.spyOn(Cart, 'updateOne').mockImplementationOnce(async (...args) => {
    await Cart.collection.updateOne({ _id: initial._id }, { $set: { 'cartItems.1.qty': 4 } });
    return realUpdate(...args);
  });
  const result = await changeAICartItem(buyer._id, { productId: String(mug._id), selectedColor: 'Silver' });
  expect(result.code).toBe('CART_CHANGED');
  const saved = await read();
  expect(saved.cartItems[0].selectedColor).toBe('Black');
  expect(saved.cartItems[1].qty).toBe(4);
});

test('cannot target a different user cart line', async () => {
  const other = await User.create({ username: 'other', email: 'other@example.com', currency: 'PKR' });
  const otherCart = await Cart.create({ user: other._id, cartItems: [{ product: lamp._id, qty: 1 }] });
  const result = await changeAICartItem(buyer._id, { cartItemId: String(otherCart.cartItems[0]._id), quantity: 4 });
  expect(result.success).toBe(false);
  expect(await read()).toEqual(initial);
});

test('a replay of the new update action returns the same receipt without repeating its write', async () => {
  const args = { cartItemId: String(initial.cartItems[0]._id), selectedColor: 'Silver', _chatRequestKey: 'color-change', _chatToolOrdinal: 0 };
  const first = await executeToolCall('update_cart_item', args, buyer.toObject());
  const after = await read();
  const retry = await executeToolCall('update_cart_item', args, buyer.toObject());
  expect(first.success).toBe(true);
  expect(retry).toEqual(first);
  expect(await read()).toEqual(after);
});

test('a mistaken add call for "silver instead" fails without adding an extra mug', async () => {
  const result = await executeToolCall('add_to_cart', {
    productId: String(mug._id), quantity: 1, selectedOptions: { Color: 'Silver', Capacity: '500ml' },
    _lastUserText: 'actually make it silver instead, same big size, still just one mug',
  }, buyer.toObject());
  expect(result.code).toBe('CART_ITEM_UPDATE_REQUIRED');
  expect(await read()).toEqual(initial);
});

test('removing a selected color leaves other variants and other products untouched', async () => {
  await Cart.updateOne({ user: buyer._id }, { $push: { cartItems: { product: mug._id, qty: 1, selectedColor: 'Silver', selectedOptions: { Color: 'Silver', Capacity: '350ml' } } } });
  const result = await changeAICartItem(buyer._id, { productName: 'mug', currentColor: 'Black' }, 'remove');
  expect(result.success).toBe(true);
  const saved = await read();
  expect(saved.cartItems).toHaveLength(2);
  expect(saved.cartItems.some(line => line.selectedColor === 'Black')).toBe(false);
  expect(saved.cartItems.find(line => String(line.product) === String(lamp._id))).toEqual(initial.cartItems[1]);
});

test('an explicit remove-all-matching request removes only that product', async () => {
  const result = await changeAICartItem(buyer._id, { productName: 'mug', allMatching: true }, 'remove');
  expect(result.success).toBe(true);
  expect((await read()).cartItems).toEqual([initial.cartItems[1]]);
});

test('a mistaken clear-cart call for removing a named product cannot remove unrelated items', async () => {
  const result = await executeToolCall('clear_cart', { _lastUserText: 'remove both mugs from my cart please' }, buyer.toObject());
  expect(result.code).toBe('CART_CLEAR_SCOPE_REQUIRED');
  expect(await read()).toEqual(initial);
});
