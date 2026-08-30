'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const {
  buildOrderSellerSettlement,
  ensureOrderExchangeRateSnapshot,
  ensureOrderSellerSettlement,
  getFrozenSellerSettlement,
} = require('../../services/orderMoneyService');

let mongoServer;

const shippingInfo = {
  fullName: 'Settlement Buyer',
  email: 'settlement-buyer@example.com',
  phone: '+923001234567',
  address: '1 Settlement Street',
  city: 'Lahore',
  state: 'Punjab',
  postalCode: '54000',
  country: 'Pakistan',
};

const createLegacyPkrOrder = async () => {
  const sellers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const amounts = [72.86, 72.86];
  const total = 145.72;
  const order = await Order.create({
    user: new mongoose.Types.ObjectId(),
    currency: 'PKR',
    orderId: `ORD-SETTLEMENT-${new mongoose.Types.ObjectId()}`,
    orderItems: amounts.map((amount, index) => ({
      productId: new mongoose.Types.ObjectId(),
      seller: sellers[index],
      name: `Settlement item ${index}`,
      price: amount,
      lineSubtotal: amount,
      quantity: 1,
    })),
    shippingInfo,
    shippingMethod: { name: 'free', price: 0, estimatedDays: 1, seller: sellers[0] },
    sellerShipping: sellers.map(seller => ({
      seller,
      shippingMethod: { name: 'free', price: 0, estimatedDays: 1 },
    })),
    orderSummary: {
      subtotal: total,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: total,
    },
    paymentMethod: 'stripe',
    isPaid: true,
    orderStatus: 'delivered',
    isDelivered: true,
  });
  return { order, sellers };
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

beforeEach(async () => {
  await Order.deleteMany({});
});

describe('durable seller settlement persistence', () => {
  test('never stamps a current live table onto a legacy foreign order without explicit audited backfill', async () => {
    const { order } = await createLegacyPkrOrder();
    const liveSnapshot = {
      base: 'USD',
      rates: { USD: 1, PKR: 999, EUR: 9, GBP: 8 },
      capturedAt: '2026-08-24T00:00:00.000Z',
      source: 'current-live-rate',
      fallback: false,
    };

    await expect(ensureOrderExchangeRateSnapshot(order, { snapshot: liveSnapshot }))
      .resolves.toBeNull();
    await expect(ensureOrderSellerSettlement(order, {
      requireOrderTotal: true,
      rateSnapshot: liveSnapshot,
    })).rejects.toMatchObject({
      code: 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING',
      statusCode: 409,
    });

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.exchangeRateSnapshot?.rates?.PKR).toBeNull();
    expect(persisted.sellerSettlementVersion).toBe(0);
    expect(persisted.sellerSettlement).toEqual([]);
  });

  test('concurrent legacy rate candidates freeze one internally consistent winner', async () => {
    const { order } = await createLegacyPkrOrder();
    const snapshots = [
      {
        base: 'USD',
        rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
        capturedAt: '2026-08-01T00:00:00.000Z',
        source: 'candidate-a',
        fallback: false,
      },
      {
        base: 'USD',
        rates: { USD: 1, PKR: 300, EUR: 0.91, GBP: 0.81 },
        capturedAt: '2026-08-02T00:00:00.000Z',
        source: 'candidate-b',
        fallback: false,
      },
    ];

    await Promise.all(snapshots.map(async snapshot => {
      const workerOrder = await Order.findById(order._id);
      await ensureOrderExchangeRateSnapshot(workerOrder, {
        snapshot,
        allowHistoricalBackfill: true,
      });
      await ensureOrderSellerSettlement(workerOrder, { requireOrderTotal: true });
    }));

    const persisted = await Order.findById(order._id);
    expect(['candidate-a', 'candidate-b']).toContain(persisted.exchangeRateSnapshot.source);
    expect(persisted.sellerSettlementVersion).toBe(1);
    const frozen = getFrozenSellerSettlement(persisted);
    const rebuilt = buildOrderSellerSettlement(persisted, { requireOrderTotal: true });
    expect(frozen).toEqual(rebuilt);
    expect(frozen.reduce((sum, entry) => sum + entry.amountUSDMinor, 0)).toBe(
      persisted.exchangeRateSnapshot.source === 'candidate-a' ? 52 : 49
    );
  });

  test('blocks later document and query mutations of a frozen settlement', async () => {
    const { order } = await createLegacyPkrOrder();
    await ensureOrderExchangeRateSnapshot(order, {
      snapshot: {
        base: 'USD',
        rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        capturedAt: '2026-08-03T00:00:00.000Z',
        source: 'immutable-test',
        fallback: false,
      },
      allowHistoricalBackfill: true,
    });
    const original = await ensureOrderSellerSettlement(order, { requireOrderTotal: true });

    const documentAttempt = await Order.findById(order._id);
    documentAttempt.sellerSettlement[0].amountUSDMinor += 10;
    documentAttempt.sellerSettlement.push({
      seller: new mongoose.Types.ObjectId(),
      sourceCurrency: 'PKR',
      sourceAmountMinor: 1,
      amountUSDMinor: 1,
    });
    await expect(documentAttempt.save()).rejects.toMatchObject({
      code: 'SELLER_SETTLEMENT_IMMUTABLE',
    });
    await Order.updateOne(
      { _id: order._id },
      { $set: { 'sellerSettlement.0.amountUSDMinor': 9999 } },
    );

    const persisted = await Order.findById(order._id);
    expect(getFrozenSellerSettlement(persisted)).toEqual(original);
  });

  test('blocks later document and query mutations of frozen seller-currency money', async () => {
    const seller = new mongoose.Types.ObjectId();
    const order = await Order.create({
      user: new mongoose.Types.ObjectId(),
      currency: 'USD',
      orderId: `ORD-NATIVE-IMMUTABLE-${new mongoose.Types.ObjectId()}`,
      orderItems: [{
        productId: new mongoose.Types.ObjectId(),
        seller,
        name: 'Immutable native item',
        price: 10,
        lineSubtotal: 10,
        sourcePrice: 10,
        sourceLineSubtotal: 10,
        sourceCurrency: 'USD',
        quantity: 1,
      }],
      shippingInfo,
      shippingMethod: { name: 'free', price: 0, estimatedDays: 1, seller },
      sellerShipping: [{
        seller,
        shippingMethod: { name: 'free', price: 0, estimatedDays: 1, sourceCost: 0, sourceCurrency: 'USD' },
      }],
      sellerPolicies: [{ seller, productCurrency: 'USD' }],
      orderSummary: { subtotal: 10, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 10 },
      sellerSettlementVersion: 1,
      sellerSettlement: [{ seller, sourceCurrency: 'USD', sourceAmountMinor: 1000, amountUSDMinor: 1000 }],
      sellerCurrencyMoneyVersion: 1,
      sellerCurrencyMoney: [{
        seller,
        currency: 'USD',
        buyerCurrency: 'USD',
        subtotalMinor: 1000,
        shippingMinor: 0,
        taxMinor: 0,
        discountMinor: 0,
        adjustmentMinor: 0,
        totalMinor: 1000,
        buyerTotalMinor: 1000,
      }],
      paymentMethod: 'stripe',
      isPaid: true,
      orderStatus: 'confirmed',
    });

    const documentAttempt = await Order.findById(order._id);
    documentAttempt.sellerCurrencyMoney[0].adjustmentMinor = 1;
    documentAttempt.sellerCurrencyMoney[0].totalMinor = 1001;
    documentAttempt.sellerCurrencyMoney.push({
      seller: new mongoose.Types.ObjectId(),
      currency: 'USD',
      buyerCurrency: 'USD',
      subtotalMinor: 1,
      shippingMinor: 0,
      taxMinor: 0,
      discountMinor: 0,
      adjustmentMinor: 0,
      totalMinor: 1,
      buyerTotalMinor: 1,
    });
    await expect(documentAttempt.save()).rejects.toMatchObject({
      code: 'SELLER_CURRENCY_MONEY_IMMUTABLE',
    });

    await Order.updateOne(
      { _id: order._id },
      { $set: { 'sellerCurrencyMoney.0.totalMinor': 9999 } },
    );

    const persisted = await Order.findById(order._id).lean();
    expect(persisted.sellerCurrencyMoney[0]).toMatchObject({
      totalMinor: 1000,
      adjustmentMinor: 0,
    });
  });
});
