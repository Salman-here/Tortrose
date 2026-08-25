const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockGetExchangeRateSnapshot = jest.fn();

jest.mock('../../config/stripe', () => ({ stripe: null, STRIPE_MODE: 'test' }));
jest.mock('../../services/currencyService', () => ({
  ...jest.requireActual('../../services/currencyService'),
  getExchangeRateSnapshot: mockGetExchangeRateSnapshot,
}));

const Order = require('../../models/Order');
const {
  exportOrders,
  getInvoice,
  _buildOrderExportMoney,
  _sumExportMinorUnits,
  _snapshotIsTrustedForConversion,
} = require('../../controllers/orderController');

const LIVE_SNAPSHOT = Object.freeze({
  base: 'USD',
  rates: { USD: 1, PKR: 280, EUR: 0.8, GBP: 0.75 },
  capturedAt: '2026-08-13T00:00:00.000Z',
  source: 'test-live-provider',
  fallback: false,
});

const response = () => ({
  statusCode: 200,
  body: null,
  headers: {},
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  send(payload) { this.body = payload; return this; },
  setHeader(name, value) { this.headers[name] = value; },
});

const createOrder = (orderId, currency, orderSummary) => Order.create({
  orderId,
  currency,
  orderItems: [{
    productId: new mongoose.Types.ObjectId(),
    seller: new mongoose.Types.ObjectId(),
    name: 'Export item',
    image: 'https://example.com/item.jpg',
    price: orderSummary.subtotal,
    quantity: 1,
  }],
  shippingInfo: {
    fullName: 'Export Buyer',
    email: 'export@example.com',
    phone: '+14155552671',
    address: '1 Report Street',
    city: 'Report City',
    state: 'Report State',
    postalCode: '10000',
    country: 'United States',
  },
  shippingMethod: { name: 'Standard', price: orderSummary.shippingCost, estimatedDays: 5 },
  orderSummary,
  paymentMethod: 'stripe',
  isPaid: true,
  awaitingPayment: false,
  orderStatus: 'confirmed',
});

describe('order export money calculations', () => {
  let mongoServer;
  let consoleError;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Order.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetExchangeRateSnapshot.mockResolvedValue(LIVE_SNAPSHOT);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleError.mockRestore();
    await Order.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  test('uses one frozen rate snapshot and exports discount plus an exactly reconciling adjustment', async () => {
    await createOrder('EXPORT-USD', 'USD', {
      subtotal: 10.01,
      shippingCost: 1.02,
      tax: 0.03,
      couponDiscount: 0.04,
      totalAmount: 11.03,
    });
    await createOrder('EXPORT-PKR', 'PKR', {
      subtotal: 350,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 350,
    });

    const res = response();
    await exportOrders({
      user: { role: 'admin', id: new mongoose.Types.ObjectId() },
      query: { format: 'csv', currency: 'EUR' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('Coupon Discount (EUR),Reconciliation Adjustment (EUR),Total (EUR)');
    expect(res.body).toContain('8.01,0.82,0.02,0.03,0.00,8.82');
    expect(res.body).toContain('1.00,0.00,0.00,0.00,0.00,1.00');
    expect(res.body).toContain('TOTALS,2,9.01,0.82,0.02,0.03,0.00,9.82');
  });

  test('fails closed when a cross-currency report only has stale fallback rates', async () => {
    await createOrder('EXPORT-STALE', 'USD', {
      subtotal: 1,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 1,
    });
    mockGetExchangeRateSnapshot.mockResolvedValue({
      ...LIVE_SNAPSHOT,
      source: 'stale',
      fallback: true,
    });

    const res = response();
    await exportOrders({
      user: { role: 'admin', id: new mongoose.Types.ObjectId() },
      query: { format: 'csv', currency: 'PKR' },
    }, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ code: 'EXCHANGE_RATES_UNAVAILABLE' });
    expect(mockGetExchangeRateSnapshot).toHaveBeenCalledTimes(1);
  });

  test('allows a same-currency report during an FX outage because no conversion occurs', async () => {
    await createOrder('EXPORT-NATIVE', 'PKR', {
      subtotal: 1000,
      shippingCost: 100,
      tax: 0,
      couponDiscount: 50,
      totalAmount: 1050,
    });
    mockGetExchangeRateSnapshot.mockResolvedValue({
      ...LIVE_SNAPSHOT,
      source: 'stale',
      fallback: true,
    });

    const res = response();
    await exportOrders({
      user: { role: 'admin', id: new mongoose.Types.ObjectId() },
      query: { format: 'csv', currency: 'PKR' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('1000.00,100.00,0.00,50.00,0.00,1050.00');
  });

  test('sums minor units exactly and rejects unsupported requested currencies', async () => {
    expect(_sumExportMinorUnits([
      { totalMinor: 10 },
      { totalMinor: 20 },
      { totalMinor: 1 },
    ], 'totalMinor')).toBe(31);

    const money = _buildOrderExportMoney({
      summary: {
        subtotal: 0.1,
        shippingCost: 0.2,
        tax: 0.3,
        couponDiscount: 0.1,
        totalAmount: 0.51,
      },
      sourceCurrency: 'USD',
      reportCurrency: 'USD',
      rateSnapshot: { ...LIVE_SNAPSHOT, source: 'stale', fallback: true },
    });
    expect(
      money.subtotalMinor
      + money.shippingMinor
      + money.taxMinor
      - money.couponDiscountMinor
      + money.reconciliationAdjustmentMinor
    ).toBe(money.totalMinor);

    const res = response();
    await exportOrders({
      user: { role: 'admin', id: new mongoose.Types.ObjectId() },
      query: { format: 'csv', currency: 'JPY' },
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'ORDER_EXPORT_CURRENCY_NOT_SUPPORTED' });
    expect(mockGetExchangeRateSnapshot).not.toHaveBeenCalled();
  });

  test.each([undefined, null, '', '1.00', true, Number.POSITIVE_INFINITY, -0.01, 1.004])(
    'rejects invalid raw persisted export money %p instead of coercing or rounding it',
    invalidAmount => {
      const summary = {
        subtotal: 1,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: invalidAmount,
      };
      expect(() => _buildOrderExportMoney({
        summary,
        sourceCurrency: 'USD',
        reportCurrency: 'USD',
        rateSnapshot: LIVE_SNAPSHOT,
      })).toThrow(expect.objectContaining({ code: 'ORDER_EXPORT_MONEY_INVALID' }));
    },
  );

  test.each(['', 'usd', ' USD ', 'CAD', false])(
    'rejects noncanonical stored order currency %p',
    storedCurrency => {
      expect(() => _buildOrderExportMoney({
        summary: {
          subtotal: 1,
          shippingCost: 0,
          tax: 0,
          couponDiscount: 0,
          totalAmount: 1,
        },
        sourceCurrency: storedCurrency,
        reportCurrency: 'USD',
        rateSnapshot: LIVE_SNAPSHOT,
      })).toThrow(expect.objectContaining({ code: 'ORDER_EXPORT_CURRENCY_INVALID' }));
    },
  );

  test('uses canonical USD only for genuinely missing legacy order currency', () => {
    expect(_buildOrderExportMoney({
      summary: {
        subtotal: 1,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1,
      },
      sourceCurrency: undefined,
      reportCurrency: 'USD',
      rateSnapshot: null,
    }).totalMinor).toBe(100);
  });

  test.each([
    ['string rate', { ...LIVE_SNAPSHOT, rates: { ...LIVE_SNAPSHOT.rates, PKR: '280' } }],
    ['non-unit USD base rate', { ...LIVE_SNAPSHOT, rates: { ...LIVE_SNAPSHOT.rates, USD: 2 } }],
    ['non-USD base', { ...LIVE_SNAPSHOT, base: 'PKR' }],
    ['non-boolean fallback', { ...LIVE_SNAPSHOT, fallback: 'false' }],
    ['blank source', { ...LIVE_SNAPSHOT, source: ' ' }],
  ])('does not trust an FX snapshot with %s', (_label, snapshot) => {
    expect(_snapshotIsTrustedForConversion(snapshot)).toBe(false);
    expect(() => _buildOrderExportMoney({
      summary: {
        subtotal: 1,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1,
      },
      sourceCurrency: 'USD',
      reportCurrency: 'PKR',
      rateSnapshot: snapshot,
    })).toThrow(expect.objectContaining({ code: 'EXCHANGE_RATES_UNAVAILABLE' }));
  });

  test.each([
    ['boolean quantity', { $set: { 'orderItems.0.quantity': true } }, 'ORDER_EXPORT_ITEM_INVALID'],
    ['sub-unit quantity', { $set: { 'orderItems.0.quantity': 0.5 } }, 'ORDER_EXPORT_ITEM_INVALID'],
    ['string total', { $set: { 'orderSummary.totalAmount': '1.00' } }, 'ORDER_EXPORT_MONEY_INVALID'],
    ['sub-cent total', { $set: { 'orderSummary.totalAmount': 1.004 } }, 'ORDER_EXPORT_MONEY_INVALID'],
    ['missing total', { $unset: { 'orderSummary.totalAmount': '' } }, 'ORDER_EXPORT_MONEY_INVALID'],
    ['noncanonical currency', { $set: { currency: 'usd' } }, 'ORDER_EXPORT_CURRENCY_INVALID'],
  ])('fails the full export for raw persisted %s', async (label, corruption, code) => {
    const order = await createOrder(`EXPORT-CORRUPT-${label}`, 'USD', {
      subtotal: 1,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 1,
    });
    await Order.collection.updateOne({ _id: order._id }, corruption);

    const res = response();
    await exportOrders({
      user: { role: 'admin', id: new mongoose.Types.ObjectId() },
      query: { format: 'csv', currency: 'USD' },
    }, res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code });
  });

  test.each([
    ['boolean quantity', { $set: { 'orderItems.0.quantity': true } }, 'ORDER_INVOICE_ITEM_INVALID'],
    ['sub-cent total', { $set: { 'orderSummary.totalAmount': 1.004 } }, 'ORDER_INVOICE_MONEY_INVALID'],
    ['blank currency', { $set: { currency: '' } }, 'ORDER_INVOICE_CURRENCY_INVALID'],
  ])('fails invoice rendering for raw persisted %s', async (label, corruption, code) => {
    const order = await createOrder(`INVOICE-CORRUPT-${label}`, 'USD', {
      subtotal: 1,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 1,
    });
    await Order.collection.updateOne({ _id: order._id }, corruption);

    const res = response();
    await getInvoice({
      params: { id: order._id.toString() },
      user: { role: 'admin', id: new mongoose.Types.ObjectId() },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code });
  });
});
