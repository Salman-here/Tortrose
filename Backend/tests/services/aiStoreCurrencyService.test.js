'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
jest.mock('../../services/currencyService', () => ({
  ...jest.requireActual('../../services/currencyService'),
  getExchangeRateSnapshot: jest.fn().mockResolvedValue({ rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, source: 'test-live', fallback: false, capturedAt: new Date().toISOString() }),
}));
const Store = require('../../models/Store');
const Product = require('../../models/Product');
const User = require('../../models/User');
const ChatHistory = require('../../models/ChatHistory');
const Preview = require('../../models/AIStoreCurrencyPreview');
const { getExchangeRateSnapshot } = require('../../services/currencyService');
const { previewStoreCurrencyChange, changeStoreCurrency, isCurrencyChangeConfirmation } = require('../../services/aiStoreCurrencyService');
const { requestProductCurrencyChange, cancelPendingProductCurrencyChange } = require('../../services/storeProductCurrencyService');
const { storeCurrencyChangeLimit } = require('../../services/storeCurrencyChangePolicy');
const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
let replica;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Preview.init();
}, 60000);
beforeEach(() => { delete process.env.STORE_CURRENCY_CHANGE_COOLDOWN_DAYS; });
afterEach(async () => {
  jest.restoreAllMocks();
  getExchangeRateSnapshot.mockResolvedValue({ rates, source: 'test-live', fallback: false, capturedAt: new Date().toISOString() });
  await Promise.all([Store, Product, User, ChatHistory, Preview].map(model => model.deleteMany({})));
});
afterAll(async () => { await mongoose.disconnect(); if (replica) await replica.stop(); }, 60000);

async function fixture(currency = 'PKR', productCount = 1) {
  const seller = await User.create({ username: 'Currency QA', email: `${new mongoose.Types.ObjectId()}@example.com`, role: 'seller', currency: 'USD' });
  const store = await Store.create({ seller: seller._id, storeName: 'Currency QA Store', storeSlug: `currency-${seller._id}`, productCurrency: currency, productCurrencyStatus: 'active', isActive: true });
  const products = [];
  for (let i = 0; i < productCount; i++) products.push(await Product.create({
    seller: seller._id, name: `Travel Cup ${i}`, description: 'Reusable thermal travel cup.',
    price: 100 * rates[currency], discountedPrice: 80 * rates[currency], currency, priceCurrency: currency,
    discountedPriceCurrency: currency, priceInputAmount: 100 * rates[currency], discountedPriceInputAmount: 80 * rates[currency],
    stock: 5, category: 'Drinkware', brand: 'QA', image: 'https://example.com/cup.png',
  }));
  return { seller, store, products };
}
const preview = (seller, currency) => previewStoreCurrencyChange(seller._id, { currency, _chatRequestKey: 'preview-turn' });
const approval = (quote, overrides = {}) => ({
  currency: quote.data.targetCurrency, _chatRequestKey: 'confirmation-turn', _lastUserText: 'yes, go ahead',
  _imageContextMessages: [{ role: 'assistant', content: `${quote.message}\n[Tool memory: ${JSON.stringify({ quoteToken: quote.data.quoteToken })}]` }],
  ...overrides,
});

describe('reviewed store-wide currency changes', () => {
  test('conversion removes a legacy discount alias instead of leaving conflicting metadata', async () => {
    const { seller, products } = await fixture();
    await Product.collection.updateOne({ _id: products[0]._id }, { $set: { discountedCurrency: 'PKR' } });
    const quote = await preview(seller, 'USD');
    expect(await changeStoreCurrency(seller._id, approval(quote))).toMatchObject({ success: true });
    const product = await Product.findById(products[0]._id).lean();
    expect(product.discountedCurrency).toBeUndefined();
    expect(product).toMatchObject({ price: 100, discountedPrice: 80, discountedPriceCurrency: 'USD' });
    expect(await requestProductCurrencyChange(seller._id, 'USD')).toMatchObject({ activeCurrency: 'USD' });
  });

  test('historical orders, account preferences and shipping terms remain byte-for-byte unchanged', async () => {
    const { seller } = await fixture();
    const Order = require('../../models/Order');
    const ShippingMethod = require('../../models/ShippingMethod');
    const orderId = new mongoose.Types.ObjectId();
    const shippingId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ _id: orderId, userId: seller._id, currency: 'PKR', orderSummary: { totalAmount: 28000 }, sellerCurrencyMoney: { immutable: 'original-snapshot' } });
    await ShippingMethod.collection.insertOne({ _id: shippingId, seller: seller._id, cost: 280, currency: 'PKR' });
    const before = await Promise.all([Order.collection.findOne({ _id: orderId }), ShippingMethod.collection.findOne({ _id: shippingId }), User.findById(seller._id).lean()]);
    await changeStoreCurrency(seller._id, approval(await preview(seller, 'USD')));
    const after = await Promise.all([Order.collection.findOne({ _id: orderId }), ShippingMethod.collection.findOne({ _id: shippingId }), User.findById(seller._id).lean()]);
    expect(after).toEqual(before);
    await Order.collection.deleteOne({ _id: orderId });
    await ShippingMethod.collection.deleteOne({ _id: shippingId });
  });

  test.each(Object.keys(rates).flatMap(from => Object.keys(rates).filter(to => to !== from).map(to => [from, to])))('%s to %s preserves value and converts regular/sale prices atomically', async (from, to) => {
    const { seller, products } = await fixture(from, 2);
    const quote = await preview(seller, to);
    expect(quote).toMatchObject({ success: true, previewOnly: true, requiresConfirmation: true, data: { sourceCurrency: from, targetCurrency: to, productCount: 2, cooldownDays: 60 } });
    expect(quote.requiredDisclosure).toContain('60 days');
    expect(quote.requiredDisclosure).toContain('Past orders and balances stay unchanged');
    expect((await Store.findOne({ seller: seller._id }).lean()).productCurrency).toBe(from);
    expect((await Product.findById(products[0]._id).lean()).price).toBe(100 * rates[from]);
    // The reviewed prices are held, not recalculated from a later rate table.
    getExchangeRateSnapshot.mockResolvedValue({ rates: { ...rates, PKR: 300 }, source: 'newer-live', fallback: false });
    const result = await changeStoreCurrency(seller._id, approval(quote));
    expect(result).toMatchObject({ success: true, data: { currency: to, converted: 2, changeLimit: { canChange: false, cooldownDays: 60, daysRemaining: 60 } } });
    const converted = await Product.find({ seller: seller._id }).lean();
    expect(converted).toHaveLength(2);
    converted.forEach(product => expect(product).toMatchObject({ price: 100 * rates[to], discountedPrice: 80 * rates[to], currency: to, priceCurrency: to, discountedPriceCurrency: to, stock: 5 }));
    const savedStore = await Store.findOne({ seller: seller._id }).lean();
    expect(savedStore).toMatchObject({ productCurrency: to, productCurrencyStatus: 'active', pendingProductCurrency: null });
    expect(new Date(result.data.changeLimit.nextAllowedAt) - savedStore.lastProductCurrencyChangeAt).toBe(60 * 86400000);
    expect((await User.findById(seller._id).lean()).currency).toBe('USD');
  });

  test.each(['no', 'yes but wait', 'what happens to my old orders?', 'yes, tell me why', 'maybe later', 'confirm PKR', 'haan mat karo', 'yes, use euros', 'yes, use rupees', 'yes, Canadian dollars', 'yes, only this product', 'yes, the product price only', 'yes, stock three'])('does not treat "%s" as approval', async text => {
    const { seller } = await fixture();
    const quote = await preview(seller, 'USD');
    expect(await changeStoreCurrency(seller._id, approval(quote, { _lastUserText: text }))).toMatchObject({ success: false, code: 'AI_CURRENCY_CONFIRMATION_REQUIRED' });
    expect((await Store.findOne({ seller: seller._id }).lean()).productCurrency).toBe('PKR');
  });

  test('same-turn, missing, wrong-owner and changed-target approvals cannot convert', async () => {
    const { seller } = await fixture();
    const { seller: stranger } = await fixture();
    const quote = await preview(seller, 'USD');
    expect(await changeStoreCurrency(seller._id, approval(quote, { _chatRequestKey: 'preview-turn' }))).toMatchObject({ success: false, code: 'AI_CURRENCY_CONFIRMATION_REQUIRED' });
    expect(await changeStoreCurrency(stranger._id, approval(quote))).toMatchObject({ success: false, code: 'AI_CURRENCY_PREVIEW_INVALID' });
    expect(await changeStoreCurrency(seller._id, approval(quote, { _imageContextMessages: [] }))).toMatchObject({ success: false, code: 'AI_CURRENCY_PREVIEW_REQUIRED' });
    expect(await changeStoreCurrency(seller._id, approval(quote, { currency: 'EUR' }))).toMatchObject({ success: false, code: 'AI_CURRENCY_TARGET_CHANGED' });
    expect((await Store.findOne({ seller: seller._id }).lean()).lastProductCurrencyChangeAt).toBeNull();
  });

  test('expired and changed-policy previews require a fresh review', async () => {
    const { seller } = await fixture();
    let quote = await preview(seller, 'USD');
    await Preview.updateOne({ token: quote.data.quoteToken }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    expect(await changeStoreCurrency(seller._id, approval(quote))).toMatchObject({ success: false, code: 'AI_CURRENCY_PREVIEW_EXPIRED' });
    quote = await preview(seller, 'USD');
    process.env.STORE_CURRENCY_CHANGE_COOLDOWN_DAYS = '90';
    expect(await changeStoreCurrency(seller._id, approval(quote))).toMatchObject({ success: false, code: 'AI_CURRENCY_POLICY_CHANGED' });
    expect((await Store.findOne({ seller: seller._id }).lean()).productCurrency).toBe('PKR');
  });

  test.each(['edit', 'insert', 'delete'])('a catalog %s after preview rejects the whole conversion', async mutation => {
    const { seller, products } = await fixture();
    const quote = await preview(seller, 'USD');
    if (mutation === 'edit') await Product.updateOne({ _id: products[0]._id }, { $set: { stock: 6 } });
    if (mutation === 'delete') await Product.deleteOne({ _id: products[0]._id });
    if (mutation === 'insert') {
      const { _id, createdAt, updatedAt, ...data } = products[0].toObject();
      await Product.create({ ...data, name: 'Another cup' });
    }
    await expect(changeStoreCurrency(seller._id, approval(quote))).rejects.toMatchObject({ code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT' });
    const savedStore = await Store.findOne({ seller: seller._id }).lean();
    expect(savedStore.productCurrency).toBe('PKR');
    expect(savedStore.lastProductCurrencyChangeAt).toBeNull();
    expect((await Preview.findOne({ token: quote.data.quoteToken }).lean()).status).toBe('quoted');
    (await Product.find({ seller: seller._id }).lean()).forEach(product => expect(product.currency).toBe('PKR'));
  });

  test('duplicate concurrent confirmations convert only once and return the committed result', async () => {
    const { seller, products } = await fixture();
    const quote = await preview(seller, 'USD');
    const results = await Promise.all([changeStoreCurrency(seller._id, approval(quote)), changeStoreCurrency(seller._id, approval(quote, { _chatRequestKey: 'retry-turn' }))]);
    expect(results.every(result => result.success)).toBe(true);
    expect((await Product.findById(products[0]._id).lean()).price).toBe(100);
    expect(await Preview.countDocuments({ status: 'committed' })).toBe(1);
    expect(await changeStoreCurrency(seller._id, approval(quote, { _chatRequestKey: 'another-retry' }))).toMatchObject({ success: true, replayed: true });
  });

  test('normal settings respect the same cooldown; no-op and cancellation do not restart it', async () => {
    const { seller } = await fixture();
    await changeStoreCurrency(seller._id, approval(await preview(seller, 'USD')));
    await expect(requestProductCurrencyChange(seller._id, 'PKR', { confirm: true })).rejects.toMatchObject({ code: 'STORE_CURRENCY_CHANGE_COOLDOWN' });
    const before = (await Store.findOne({ seller: seller._id }).lean()).lastProductCurrencyChangeAt;
    expect(await requestProductCurrencyChange(seller._id, 'USD')).toMatchObject({ activeCurrency: 'USD', changeLimit: { canChange: false, cooldownDays: 60 } });
    await cancelPendingProductCurrencyChange(seller._id);
    expect((await Store.findOne({ seller: seller._id }).lean()).lastProductCurrencyChangeAt).toEqual(before);
  });

  test('empty-store switches still require review and start the cooldown only after confirmation', async () => {
    const { seller } = await fixture('USD', 0);
    expect(await requestProductCurrencyChange(seller._id, 'PKR')).toMatchObject({ requiresConfirmation: true, activeCurrency: 'USD' });
    const quote = await preview(seller, 'PKR');
    expect(quote.data.productCount).toBe(0);
    expect((await Store.findOne({ seller: seller._id }).lean()).lastProductCurrencyChangeAt).toBeNull();
    expect(await changeStoreCurrency(seller._id, approval(quote))).toMatchObject({ success: true, data: { currency: 'PKR', converted: 0 } });
  });

  test('blocked stores, unavailable FX, unsupported currencies and tiny prices fail without writes', async () => {
    const { seller, products } = await fixture();
    await expect(preview(seller, 'CAD')).rejects.toMatchObject({ code: 'PRODUCT_CURRENCY_METADATA_INVALID' });
    getExchangeRateSnapshot.mockResolvedValue({ rates, fallback: true });
    await expect(preview(seller, 'USD')).rejects.toMatchObject({ code: 'EXCHANGE_RATES_UNAVAILABLE' });
    getExchangeRateSnapshot.mockResolvedValue({ rates, fallback: false });
    await Product.updateOne({ _id: products[0]._id }, { $set: { price: 0.01, discountedPrice: 0, priceInputAmount: 0.01, discountedPriceInputAmount: 0 } });
    await expect(preview(seller, 'USD')).rejects.toMatchObject({ code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE' });
    await Store.updateOne({ seller: seller._id }, { $set: { isActive: false } });
    await expect(preview(seller, 'USD')).rejects.toMatchObject({ code: 'STORE_BLOCKED' });
    expect(await Preview.countDocuments({})).toBe(0);
    expect((await Store.findOne({ seller: seller._id }).lean()).lastProductCurrencyChangeAt).toBeNull();
  });

  test('old clients recover only the selected owners latest preview from saved history', async () => {
    const { seller } = await fixture();
    const quote = await preview(seller, 'USD');
    const conversationId = new mongoose.Types.ObjectId();
    await ChatHistory.create({ user: seller._id, conversations: [{ _id: conversationId, messages: [{ role: 'assistant', content: quote.message, toolEvents: [{ type: 'tool_result', tool: 'preview_store_currency_change', result: quote }] }] }] });
    expect(await changeStoreCurrency(seller._id, approval(quote, { _chatConversationId: String(conversationId), _imageContextMessages: [{ role: 'assistant', content: quote.message }] }))).toMatchObject({ success: true });
  });
});

test('the sixty-day boundary is exact and old request/cancel timestamps do not lock sellers', () => {
  const now = Date.now();
  expect(storeCurrencyChangeLimit({ productCurrencyChangedAt: new Date(now) }, now).canChange).toBe(true);
  const last = new Date(now - 60 * 86400000);
  expect(storeCurrencyChangeLimit({ lastProductCurrencyChangeAt: last }, now).canChange).toBe(true);
  expect(storeCurrencyChangeLimit({ lastProductCurrencyChangeAt: last }, now - 1).canChange).toBe(false);
  expect(isCurrencyChangeConfirmation('haan kar do', 'USD')).toBe(true);
});
