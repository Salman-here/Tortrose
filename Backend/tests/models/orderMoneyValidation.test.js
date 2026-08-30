'use strict';

const mongoose = require('mongoose');
const Order = require('../../models/Order');

const objectId = () => new mongoose.Types.ObjectId();

const validOrder = overrides => new Order({
  user: objectId(),
  orderId: `ORDER-MONEY-${new mongoose.Types.ObjectId()}`,
  currency: 'PKR',
  exchangeRateSnapshot: {
    base: 'USD',
    rates: { USD: 1, PKR: 277.51, EUR: 0.856, GBP: 0.733 },
    capturedAt: new Date(),
    source: 'test',
    fallback: false,
  },
  orderItems: [{
    productId: objectId(),
    seller: objectId(),
    name: 'Native PKR item',
    image: 'https://example.com/item.jpg',
    price: 1000,
    lineSubtotal: 2000,
    sourcePrice: 1000,
    sourceCurrency: 'PKR',
    sourceLineSubtotal: 2000,
    priceOriginal: 1000,
    priceCurrency: 'PKR',
    quantity: 2,
  }],
  shippingInfo: {
    fullName: 'Money Buyer',
    email: 'money@example.com',
    phone: '+923001234567',
    address: '1 Money Road',
    city: 'Karachi',
    state: 'Sindh',
    postalCode: '74000',
    country: 'Pakistan',
  },
  shippingMethod: { name: 'free', price: 0, estimatedDays: 3 },
  sellerShipping: [],
  orderSummary: {
    subtotal: 2000,
    shippingCost: 0,
    tax: 0,
    couponDiscount: 0,
    totalAmount: 2000,
  },
  paymentMethod: 'cash_on_delivery',
  paymentSetupState: 'closed',
  ...overrides,
});

describe('order financial persistence validation', () => {
  test('accepts exact native-currency money and a trusted multi-currency rate snapshot', async () => {
    await expect(validOrder().validate()).resolves.toBeUndefined();
  });

  test('freezes a country-aware E.164 destination at the persistence boundary', async () => {
    const order = validOrder();
    order.shippingInfo.phone = '020 7946 0018';
    order.shippingInfo.country = 'United Kingdom';
    order.shippingInfo.countryCode = 'GB';

    await expect(order.validate()).resolves.toBeUndefined();
    expect(order.shippingInfo.phone).toBe('+442079460018');
    expect(order.shippingInfo.phoneE164).toBe('+442079460018');
    expect(order.shippingInfo.countryCode).toBe('GB');
  });

  test('rejects ambiguous local phones and conflicting destination snapshots', async () => {
    const ambiguous = validOrder();
    ambiguous.shippingInfo.phone = '0300 1234567';
    ambiguous.shippingInfo.country = undefined;
    ambiguous.shippingInfo.countryCode = '';
    await expect(ambiguous.validate()).rejects.toMatchObject({ code: 'SHIPPING_PHONE_INVALID' });

    const mismatched = validOrder();
    mismatched.shippingInfo.phoneE164 = '+14155552671';
    await expect(mismatched.validate()).rejects.toMatchObject({ code: 'SHIPPING_PHONE_MISMATCH' });
  });

  test('allows a fractional converted display unit while freezing the exact charged line subtotal', async () => {
    const order = validOrder();
    order.orderItems[0].price = 0.0035714285714285713;
    order.orderItems[0].lineSubtotal = 0.01;
    await expect(order.validate()).resolves.toBeUndefined();
  });

  test.each([true, '', Number.POSITIVE_INFINITY, 1.001, Number.MAX_SAFE_INTEGER])(
    'rejects unsafe order total %p before persistence',
    async totalAmount => {
      const order = validOrder();
      order.orderSummary.totalAmount = totalAmount;
      await expect(order.validate()).rejects.toThrow(/totalAmount|Stored order money/);
    },
  );

  test.each([
    ['price', true],
    ['lineSubtotal', ''],
    ['sourcePrice', Number.POSITIVE_INFINITY],
    ['sourceLineSubtotal', 0.001],
    ['priceOriginal', Number.MAX_SAFE_INTEGER],
  ])('rejects unsafe order-item %s %p before persistence', async (field, value) => {
    const order = validOrder();
    order.orderItems[0][field] = value;
    await expect(order.validate()).rejects.toThrow(new RegExp(field));
  });

  test.each([true, '', 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe order quantity %p before persistence',
    async quantity => {
      const order = validOrder();
      order.orderItems[0].quantity = quantity;
      await expect(order.validate()).rejects.toThrow(/quantity/);
    },
  );

  test.each([true, '', 0, Number.POSITIVE_INFINITY])(
    'rejects an invalid PKR exchange rate %p',
    async rate => {
      const order = validOrder();
      order.exchangeRateSnapshot.rates.PKR = rate;
      await expect(order.validate()).rejects.toThrow(/PKR|exchange rate/);
    },
  );

  test('requires the USD snapshot anchor to remain exactly one', async () => {
    const order = validOrder();
    order.exchangeRateSnapshot.rates.USD = 1.01;
    await expect(order.validate()).rejects.toThrow(/USD|equal 1/);
  });

  test.each([true, '', -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe seller settlement version %p',
    async sellerSettlementVersion => {
      const order = validOrder({ sellerSettlementVersion });
      await expect(order.validate()).rejects.toThrow(/sellerSettlementVersion|settlement version/);
    },
  );

  test('rejects sub-cent frozen shipping and coupon allocations', async () => {
    const order = validOrder({
      appliedCoupons: [{
        couponId: objectId(),
        seller: objectId(),
        code: 'PKR10',
        discountType: 'fixed',
        discountValue: 10,
        appliedDiscountAmount: 10,
        currency: 'PKR',
        sourceDiscountValue: 10,
        sourceCurrency: 'PKR',
        couponTermsFingerprint: 'a'.repeat(64),
      }],
    });
    order.shippingMethod.price = 0.001;
    order.appliedCoupons[0].appliedDiscountAmount = 0.001;
    await expect(order.validate()).rejects.toThrow(/shippingMethod\.price|appliedDiscountAmount|Stored order money/);
  });

  test('persists exact seller-native minor units and rejects unsafe snapshot integers', async () => {
    const order = validOrder();
    const seller = order.orderItems[0].seller;
    order.sellerSettlementVersion = 1;
    order.sellerSettlement = [{
      seller,
      sourceCurrency: 'PKR',
      sourceAmountMinor: 200000,
      amountUSDMinor: 721,
    }];
    order.sellerCurrencyMoneyVersion = 1;
    order.sellerCurrencyMoney = [{
      seller,
      currency: 'PKR',
      buyerCurrency: 'PKR',
      subtotalMinor: 200000,
      shippingMinor: 0,
      taxMinor: 0,
      discountMinor: 0,
      adjustmentMinor: 0,
      totalMinor: 200000,
      buyerTotalMinor: 200000,
    }];
    await expect(order.validate()).resolves.toBeUndefined();

    order.sellerCurrencyMoney[0].adjustmentMinor = 0.5;
    await expect(order.validate()).rejects.toThrow(/sellerCurrencyMoney|native adjustment|safe minor units/);
  });

  test('rejects a sub-cent seller source coupon allocation', async () => {
    const order = validOrder({
      appliedCoupons: [{
        couponId: objectId(),
        seller: objectId(),
        code: 'SOURCE10',
        discountType: 'fixed',
        discountValue: 10,
        appliedDiscountAmount: 10,
        currency: 'PKR',
        sourceAppliedDiscountAmount: 0.001,
        sourceDiscountValue: 10,
        sourceCurrency: 'PKR',
        couponTermsFingerprint: 'b'.repeat(64),
      }],
    });
    await expect(order.validate()).rejects.toThrow(/sourceAppliedDiscountAmount|Stored order money/);
  });
});
