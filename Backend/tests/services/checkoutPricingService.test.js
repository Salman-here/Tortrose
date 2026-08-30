'use strict';

jest.mock('../../models/Coupon', () => ({ find: jest.fn() }));
jest.mock('../../models/ShippingMethod', () => ({ find: jest.fn() }));
jest.mock('../../services/currencyService', () => ({
    isSupportedCurrency: value => ['USD', 'PKR', 'EUR', 'GBP'].includes(String(value || '').trim().toUpperCase()),
    normalizeCurrency: value => String(value || 'USD').toUpperCase(),
    normalizeRates: rates => {
        if (!rates || typeof rates !== 'object') return null;
        const normalized = { USD: 1 };
        for (const currency of ['PKR', 'EUR', 'GBP']) {
            const value = Number(rates[currency]);
            if (!Number.isFinite(value) || value <= 0) return null;
            normalized[currency] = value;
        }
        return normalized;
    },
    getExchangeRateSnapshot: jest.fn(async () => ({
        rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
        fallback: false,
    })),
    convertAmountWithRates: jest.fn((amount, from, to, rates) => (
        (Number(amount) / rates[String(from).toUpperCase()]) * rates[String(to).toUpperCase()]
    )),
    convertAmount: jest.fn(async (amount, from, to) => {
        const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
        return (Number(amount) / rates[String(from).toUpperCase()]) * rates[String(to).toUpperCase()];
    }),
}));

const Coupon = require('../../models/Coupon');
const ShippingMethod = require('../../models/ShippingMethod');
const { getExchangeRateSnapshot } = require('../../services/currencyService');
const {
    allocateCheckoutAmountsBySource,
    validateAndPriceCoupons,
    validateAndPriceShipping,
} = require('../../services/checkoutPricingService');
const { buildOrderItemDiscountAllocations } = require('../../services/orderDiscountService');

const queryResult = value => ({ lean: jest.fn().mockResolvedValue(value) });
const COUPON_ID = '64b000000000000000000001';
const COUPON_ID_2 = '64b000000000000000000002';

const fixedCoupon = ({
    _id,
    seller,
    code,
    discountValue,
    currency,
    productId,
    maxDiscountAmount = null,
}) => ({
    _id,
    seller,
    code,
    discountType: 'fixed',
    discountValue,
    currency,
    applicableTo: 'selected',
    applicableProducts: [productId],
    minOrderAmount: 0,
    maxDiscountAmount,
    maxUses: null,
    maxUsesPerUser: 1,
    usedCount: 0,
    usedBy: [],
    isActive: true,
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    expiryDate: new Date('2030-01-01T00:00:00.000Z'),
});

describe('checkoutPricingService', () => {
    beforeEach(() => jest.clearAllMocks());

    test('reloads coupon terms and stores the actual capped discount', async () => {
        Coupon.find.mockReturnValue(queryResult([{
            _id: COUPON_ID,
            seller: 'seller-1',
            code: 'SAFE10',
            discountType: 'percentage',
            discountValue: 50,
            currency: 'USD',
            applicableTo: 'all',
            applicableProducts: [],
            minOrderAmount: 20,
            maxDiscountAmount: 10,
            maxUses: null,
            maxUsesPerUser: 1,
            usedCount: 0,
            usedBy: [],
            isActive: true,
            startDate: new Date('2025-01-01T00:00:00.000Z'),
            expiryDate: new Date('2030-01-01T00:00:00.000Z'),
        }]));

        const result = await validateAndPriceCoupons({
            requestedCoupons: [{
                couponId: COUPON_ID,
                discountValue: 999999,
                applicableProductIds: ['product-1'],
            }],
            orderItems: [{ productId: 'product-1', seller: 'seller-1', price: 100, quantity: 1 }],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            at: new Date('2026-01-01T00:00:00.000Z'),
        });

        expect(result.couponDiscount).toBe(10);
        expect(result.appliedCoupons[0]).toMatchObject({
            code: 'SAFE10',
            discountType: 'percentage',
            discountValue: 50,
            appliedDiscountAmount: 10,
            currency: 'USD',
            sourceAppliedDiscountAmount: 10,
            sourceCurrency: 'USD',
        });
    });

    test('freezes the exact seller-currency coupon amount beside the buyer PKR allocation', async () => {
        Coupon.find.mockReturnValue(queryResult([{
            _id: COUPON_ID,
            seller: 'seller-usd',
            code: 'USD10',
            discountType: 'percentage',
            discountValue: 10,
            currency: 'USD',
            applicableTo: 'all',
            applicableProducts: [],
            minOrderAmount: 0,
            maxDiscountAmount: null,
            maxUses: null,
            maxUsesPerUser: 1,
            usedCount: 0,
            usedBy: [],
            isActive: true,
            startDate: new Date('2025-01-01T00:00:00.000Z'),
            expiryDate: new Date('2030-01-01T00:00:00.000Z'),
        }]));

        const result = await validateAndPriceCoupons({
            requestedCoupons: [{ couponId: COUPON_ID, applicableProductIds: ['product-usd'] }],
            orderItems: [{
                productId: 'product-usd',
                seller: 'seller-usd',
                price: 8196.87,
                lineSubtotal: 8196.87,
                sourcePrice: 29.5,
                sourceCurrency: 'USD',
                sourceLineSubtotal: 29.5,
                quantity: 1,
            }],
            userId: 'buyer-1',
            orderCurrency: 'PKR',
            exchangeRates: { USD: 1, PKR: 277.86, EUR: 0.92, GBP: 0.79 },
            at: new Date('2026-01-01T00:00:00.000Z'),
        });

        expect(result.couponDiscount).toBe(819.69);
        expect(result.appliedCoupons[0]).toMatchObject({
            appliedDiscountAmount: 819.69,
            currency: 'PKR',
            sourceAppliedDiscountAmount: 2.95,
            sourceCurrency: 'USD',
        });
    });

    test.each([
        [10, true],
        [9.99, false],
    ])(
        'compares an exact coupon minimum in minor units: subtotal %s eligible=%s',
        async (subtotal, eligible) => {
            Coupon.find.mockReturnValue(queryResult([{
                ...fixedCoupon({
                    _id: COUPON_ID,
                    seller: 'seller-1',
                    code: 'EXACTMIN',
                    discountValue: 1,
                    currency: 'USD',
                    productId: 'product-1',
                }),
                minOrderAmount: 10,
            }]));

            const operation = validateAndPriceCoupons({
                requestedCoupons: [{ couponId: COUPON_ID }],
                orderItems: [{
                    productId: 'product-1',
                    seller: 'seller-1',
                    price: subtotal,
                    quantity: 1,
                }],
                userId: 'buyer-1',
                orderCurrency: 'USD',
                at: new Date('2026-01-01T00:00:00.000Z'),
            });

            if (eligible) {
                await expect(operation).resolves.toMatchObject({ couponDiscount: 1 });
            } else {
                await expect(operation).rejects.toMatchObject({
                    code: 'COUPON_MINIMUM_NOT_MET',
                    statusCode: 400,
                });
            }
        },
    );

    test.each([
        ['unknown discount type', { discountType: 'bogus' }],
        ['non-finite discount', { discountValue: Number.POSITIVE_INFINITY }],
        ['sub-cent fixed discount', { discountValue: 0.001 }],
        ['over-precise percentage', { discountType: 'percentage', discountValue: 33.3333333 }],
        ['invalid usage limit', { maxUsesPerUser: true }],
        ['invalid date range', { expiryDate: new Date('2024-01-01T00:00:00.000Z') }],
    ])('fails closed for persisted coupon corruption: %s', async (_label, override) => {
        Coupon.find.mockReturnValue(queryResult([{
            ...fixedCoupon({
                _id: COUPON_ID,
                seller: 'seller-1',
                code: 'CORRUPT',
                discountValue: 5,
                currency: 'USD',
                productId: 'product-1',
            }),
            ...override,
        }]));

        await expect(validateAndPriceCoupons({
            requestedCoupons: [{ couponId: COUPON_ID }],
            orderItems: [{ productId: 'product-1', seller: 'seller-1', price: 100, quantity: 1 }],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            at: new Date('2026-01-01T00:00:00.000Z'),
        })).rejects.toMatchObject({ code: 'COUPON_CONFIG_INVALID', statusCode: 409 });
    });

    test('fetches a trusted snapshot and fails closed when foreign coupon terms have no supplied rates', async () => {
        Coupon.find.mockReturnValue(queryResult([{
            _id: COUPON_ID,
            seller: 'seller-1',
            code: 'PKRMIN',
            discountType: 'percentage',
            discountValue: 10,
            currency: 'PKR',
            applicableTo: 'all',
            applicableProducts: [],
            minOrderAmount: 100,
            maxDiscountAmount: null,
            maxUses: null,
            maxUsesPerUser: 1,
            usedCount: 0,
            usedBy: [],
            isActive: true,
            startDate: new Date('2025-01-01T00:00:00.000Z'),
            expiryDate: new Date('2030-01-01T00:00:00.000Z'),
        }]));
        getExchangeRateSnapshot.mockResolvedValueOnce({
            rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
            fallback: true,
        });

        await expect(validateAndPriceCoupons({
            requestedCoupons: [{ couponId: COUPON_ID }],
            orderItems: [{ productId: 'product-1', seller: 'seller-1', price: 100, quantity: 1 }],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            at: new Date('2026-01-01T00:00:00.000Z'),
        })).rejects.toMatchObject({ code: 'EXCHANGE_RATES_UNAVAILABLE', statusCode: 503 });
    });

    test.each([undefined, '', 'usd', ' USD '])(
        'fails closed for missing or noncanonical stored coupon currency %p',
        async storedCurrency => {
            Coupon.find.mockReturnValue(queryResult([fixedCoupon({
                _id: COUPON_ID,
                seller: 'seller-1',
                code: 'BAD-CURRENCY',
                discountValue: 5,
                currency: storedCurrency,
                productId: 'product-1',
            })]));

            await expect(validateAndPriceCoupons({
                requestedCoupons: [{ couponId: COUPON_ID }],
                orderItems: [{ productId: 'product-1', seller: 'seller-1', price: 100, quantity: 1 }],
                userId: 'buyer-1',
                orderCurrency: 'USD',
                at: new Date('2026-01-01T00:00:00.000Z'),
            })).rejects.toMatchObject({
                code: 'COUPON_CURRENCY_NOT_SUPPORTED',
                statusCode: 409,
            });
        },
    );

    test('rejects a client coupon scope that is not configured for the coupon seller', async () => {
        Coupon.find.mockReturnValue(queryResult([{
            _id: COUPON_ID,
            seller: 'seller-1',
            code: 'ONLYONE',
            discountType: 'fixed',
            discountValue: 5,
            currency: 'USD',
            applicableTo: 'selected',
            applicableProducts: ['product-1'],
            minOrderAmount: 0,
            maxDiscountAmount: null,
            maxUses: null,
            maxUsesPerUser: 1,
            usedCount: 0,
            usedBy: [],
            isActive: true,
            startDate: new Date('2025-01-01T00:00:00.000Z'),
            expiryDate: new Date('2030-01-01T00:00:00.000Z'),
        }]));

        await expect(validateAndPriceCoupons({
            requestedCoupons: [{ couponId: COUPON_ID, applicableProductIds: ['product-2'] }],
            orderItems: [
                { productId: 'product-1', seller: 'seller-1', price: 50, quantity: 1 },
                { productId: 'product-2', seller: 'seller-2', price: 50, quantity: 1 },
            ],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            at: new Date('2026-01-01T00:00:00.000Z'),
        })).rejects.toMatchObject({ code: 'COUPON_SCOPE_INVALID', statusCode: 400 });
    });

    test('globally rounds disjoint fixed coupons from different foreign currencies', async () => {
        Coupon.find.mockReturnValue(queryResult([
            fixedCoupon({
                _id: COUPON_ID,
                seller: 'seller-pkr',
                code: 'PKRONE',
                discountValue: 1,
                currency: 'PKR',
                productId: 'product-pkr',
            }),
            fixedCoupon({
                _id: COUPON_ID_2,
                seller: 'seller-gbp',
                code: 'GBPONE',
                discountValue: 0.01,
                currency: 'GBP',
                productId: 'product-gbp',
            }),
        ]));

        const result = await validateAndPriceCoupons({
            requestedCoupons: [
                { couponId: COUPON_ID, applicableProductIds: ['product-pkr'] },
                { couponId: COUPON_ID_2, applicableProductIds: ['product-gbp'] },
            ],
            orderItems: [
                { productId: 'product-pkr', seller: 'seller-pkr', price: 1, quantity: 1, lineSubtotal: 1 },
                { productId: 'product-gbp', seller: 'seller-gbp', price: 1, quantity: 1, lineSubtotal: 1 },
            ],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
            at: new Date('2026-01-01T00:00:00.000Z'),
        });

        // Exact values are about 0.351c + 1.266c; globally they round to 2c.
        expect(result.appliedCoupons.map(coupon => coupon.appliedDiscountAmount)).toEqual([0.01, 0.01]);
        expect(result.couponDiscount).toBe(0.02);
    });

    test('redistributes a foreign coupon rounding cent without exceeding a rounded max cap', async () => {
        Coupon.find.mockReturnValue(queryResult([
            fixedCoupon({
                _id: COUPON_ID,
                seller: 'seller-a',
                code: 'CAPPED',
                discountValue: 10,
                maxDiscountAmount: 3.99,
                currency: 'PKR',
                productId: 'product-a',
            }),
            fixedCoupon({
                _id: COUPON_ID_2,
                seller: 'seller-b',
                code: 'OTHER',
                discountValue: 1.14,
                currency: 'PKR',
                productId: 'product-b',
            }),
        ]));

        const result = await validateAndPriceCoupons({
            requestedCoupons: [
                { couponId: COUPON_ID, applicableProductIds: ['product-a'] },
                { couponId: COUPON_ID_2, applicableProductIds: ['product-b'] },
            ],
            orderItems: [
                { productId: 'product-a', seller: 'seller-a', price: 1, quantity: 1, lineSubtotal: 1 },
                { productId: 'product-b', seller: 'seller-b', price: 1, quantity: 1, lineSubtotal: 1 },
            ],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
            at: new Date('2026-01-01T00:00:00.000Z'),
        });

        expect(result.appliedCoupons.map(coupon => coupon.appliedDiscountAmount)).toEqual([0.01, 0.01]);
        expect(result.couponDiscount).toBe(0.02);
    });

    test('rejects a selected foreign coupon that would consume a use for a zero-cent allocation', async () => {
        Coupon.find.mockReturnValue(queryResult([
            fixedCoupon({
                _id: COUPON_ID,
                seller: 'seller-a',
                code: 'TOOSMALL',
                discountValue: 1,
                currency: 'PKR',
                productId: 'product-a',
            }),
            fixedCoupon({
                _id: COUPON_ID_2,
                seller: 'seller-b',
                code: 'ONECENT',
                discountValue: 3,
                currency: 'PKR',
                productId: 'product-b',
            }),
        ]));

        await expect(validateAndPriceCoupons({
            requestedCoupons: [
                { couponId: COUPON_ID, applicableProductIds: ['product-a'] },
                { couponId: COUPON_ID_2, applicableProductIds: ['product-b'] },
            ],
            orderItems: [
                { productId: 'product-a', seller: 'seller-a', price: 1, quantity: 1, lineSubtotal: 1 },
                { productId: 'product-b', seller: 'seller-b', price: 1, quantity: 1, lineSubtotal: 1 },
            ],
            userId: 'buyer-1',
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 300, EUR: 0.92, GBP: 0.79 },
            at: new Date('2026-01-01T00:00:00.000Z'),
        })).rejects.toMatchObject({
            code: 'COUPON_DISCOUNT_INVALID',
            message: expect.stringContaining('TOOSMALL'),
        });
    });

    test('uses the stored active shipping method instead of a client supplied price', async () => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-1',
            methods: [{ type: 'standard', cost: 7, currency: 'USD', deliveryDays: 4, isActive: true }],
        }]));

        const result = await validateAndPriceShipping({
            requestedSellerShipping: [{
                seller: 'seller-1',
                shippingMethod: { name: 'standard', price: 0, estimatedDays: 1 },
            }],
            sellerIds: ['seller-1'],
            orderCurrency: 'USD',
        });

        expect(result.shippingCost).toBe(7);
        expect(result.sellerShipping[0].shippingMethod).toEqual({
            name: 'standard',
            price: 7,
            estimatedDays: 4,
            sourceCost: 7,
            sourceCurrency: 'USD',
        });
    });

    test('rejects shipping methods that became inactive before order creation', async () => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-1',
            methods: [{ type: 'standard', cost: 7, currency: 'USD', deliveryDays: 4, isActive: false }],
        }]));

        await expect(validateAndPriceShipping({
            requestedSellerShipping: [{ seller: 'seller-1', shippingMethod: { name: 'standard' } }],
            sellerIds: ['seller-1'],
            orderCurrency: 'USD',
        })).rejects.toMatchObject({ code: 'SHIPPING_METHOD_NOT_AVAILABLE', statusCode: 400 });
    });

    test('allocates mixed PKR and USD seller shipping with one checkout snapshot', async () => {
        ShippingMethod.find.mockReturnValue(queryResult([
            {
                seller: 'seller-pkr',
                methods: [{ type: 'standard', cost: 280, currency: 'PKR', deliveryDays: 3, isActive: true }],
            },
            {
                seller: 'seller-usd',
                methods: [{ type: 'standard', cost: 1, currency: 'USD', deliveryDays: 5, isActive: true }],
            },
        ]));

        const result = await validateAndPriceShipping({
            requestedSellerShipping: [
                { seller: 'seller-pkr', shippingMethod: { name: 'standard' } },
                { seller: 'seller-usd', shippingMethod: { name: 'standard' } },
            ],
            sellerIds: ['seller-pkr', 'seller-usd'],
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
            exchangeRatesFallback: false,
        });

        expect(result.sellerShipping).toEqual([
            {
                seller: 'seller-pkr',
                shippingMethod: {
                    name: 'standard',
                    price: 1,
                    estimatedDays: 3,
                    sourceCost: 280,
                    sourceCurrency: 'PKR',
                },
            },
            {
                seller: 'seller-usd',
                shippingMethod: {
                    name: 'standard',
                    price: 1,
                    estimatedDays: 5,
                    sourceCost: 1,
                    sourceCurrency: 'USD',
                },
            },
        ]);
        expect(result.shippingCost).toBe(2);
    });

    test('uses canonical USD for legacy shipping rows with no currency metadata', async () => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-pkr',
            methods: [{ type: 'standard', cost: 500, deliveryDays: 3, isActive: true }],
        }]));
        const request = {
            requestedSellerShipping: [{ seller: 'seller-pkr', shippingMethod: { name: 'standard' } }],
            sellerIds: ['seller-pkr'],
            sellerCurrencies: { 'seller-pkr': 'PKR' },
            exchangeRates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
            exchangeRatesFallback: false,
        };

        const usd = await validateAndPriceShipping({ ...request, orderCurrency: 'USD' });
        const pkr = await validateAndPriceShipping({ ...request, orderCurrency: 'PKR' });

        expect(usd.sellerShipping[0].shippingMethod).toMatchObject({
            sourceCost: 500,
            sourceCurrency: 'USD',
            price: 500,
        });
        expect(pkr.sellerShipping[0].shippingMethod).toMatchObject({
            sourceCost: 500,
            sourceCurrency: 'USD',
            price: 140000,
        });
    });

    test.each([
        ['unsupported secondary currency', { currency: 'USD', costCurrency: 'CAD' }, 'SHIPPING_CURRENCY_NOT_SUPPORTED'],
        ['blank present currency', { currency: 'USD', costCurrency: '' }, 'SHIPPING_CURRENCY_NOT_SUPPORTED'],
        ['lowercase present currency', { currency: 'usd' }, 'SHIPPING_CURRENCY_NOT_SUPPORTED'],
        ['whitespace-padded present currency', { currency: ' USD ' }, 'SHIPPING_CURRENCY_NOT_SUPPORTED'],
        ['conflicting currencies', { currency: 'PKR', costCurrency: 'USD' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ])('fails closed for %s in a stored shipping row', async (_label, currencyFields, code) => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-1',
            methods: [{
                type: 'standard',
                cost: 10,
                deliveryDays: 3,
                isActive: true,
                ...currencyFields,
            }],
        }]));

        await expect(validateAndPriceShipping({
            requestedSellerShipping: [{ seller: 'seller-1', shippingMethod: { name: 'standard' } }],
            sellerIds: ['seller-1'],
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
            exchangeRatesFallback: false,
        })).rejects.toMatchObject({ code });
    });

    test.each([
        ['paid sub-cent cost', { type: 'standard', cost: 0.004, costInputAmount: 0.01 }],
        ['paid sub-cent input amount', { type: 'standard', cost: 7, costInputAmount: 0.004 }],
        ['paid zero cost', { type: 'standard', cost: 0, costInputAmount: 0 }],
        ['free nonzero cost', { type: 'free', cost: 0.01, costInputAmount: 0 }],
        ['non-finite cost', { type: 'standard', cost: Number.POSITIVE_INFINITY, costInputAmount: 1 }],
        ['string stored cost', { type: 'standard', cost: '7.00', costInputAmount: 7 }],
    ])('fails closed for corrupt stored shipping money: %s', async (_label, storedMoney) => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-1',
            methods: [{
                ...storedMoney,
                currency: 'USD',
                costCurrency: 'USD',
                deliveryDays: 3,
                isActive: true,
            }],
        }]));

        await expect(validateAndPriceShipping({
            requestedSellerShipping: [{
                seller: 'seller-1',
                shippingMethod: { name: storedMoney.type },
            }],
            sellerIds: ['seller-1'],
            orderCurrency: 'USD',
        })).rejects.toMatchObject({ code: 'SHIPPING_COST_INVALID', statusCode: 409 });
    });

    test.each([
        ['missing', undefined],
        ['null', null],
        ['boolean', true],
        ['numeric string', '3'],
        ['fractional', 1.5],
        ['zero', 0],
        ['negative', -2],
        ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ])('fails closed for corrupt stored shipping delivery days: %s', async (_label, deliveryDays) => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-1',
            methods: [{
                type: 'standard',
                cost: 7,
                currency: 'USD',
                costCurrency: 'USD',
                costInputAmount: 7,
                deliveryDays,
                isActive: true,
            }],
        }]));

        await expect(validateAndPriceShipping({
            requestedSellerShipping: [{ seller: 'seller-1', shippingMethod: { name: 'standard' } }],
            sellerIds: ['seller-1'],
            orderCurrency: 'USD',
        })).rejects.toMatchObject({ code: 'SHIPPING_DATA_INVALID', statusCode: 409 });
    });

    test('converts one source-currency shipping bucket and conserves its target cents', async () => {
        ShippingMethod.find.mockReturnValue(queryResult([
            {
                seller: 'seller-a',
                methods: [{ type: 'standard', cost: 2, currency: 'PKR', deliveryDays: 3, isActive: true }],
            },
            {
                seller: 'seller-b',
                methods: [{ type: 'standard', cost: 2, currency: 'PKR', deliveryDays: 4, isActive: true }],
            },
        ]));

        const result = await validateAndPriceShipping({
            requestedSellerShipping: [
                { seller: 'seller-a', shippingMethod: { name: 'standard' } },
                { seller: 'seller-b', shippingMethod: { name: 'standard' } },
            ],
            sellerIds: ['seller-a', 'seller-b'],
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 },
            exchangeRatesFallback: false,
        });

        // PKR 4 / 300 rounds once to USD 0.01. Per-seller conversion would
        // incorrectly charge USD 0.02 (0.01 + 0.01).
        expect(result.sellerShipping.map(entry => entry.shippingMethod.price)).toEqual([0.01, 0]);
        expect(result.shippingCost).toBe(0.01);
        expect(result.sellerShipping.map(entry => entry.shippingMethod.sourceCost)).toEqual([2, 2]);
    });

    test('does not erase many collectively billable sub-cent shipping entries', async () => {
        const entries = Array.from({ length: 100 }, (_, index) => ({
            key: `seller-${index}`,
            sourceAmount: 1,
            sourceCurrency: 'PKR',
        }));
        const allocated = await allocateCheckoutAmountsBySource({
            entries,
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
        });

        expect(allocated.filter(entry => entry.targetAmount === 0.01)).toHaveLength(36);
        expect(allocated.filter(entry => entry.targetAmount === 0)).toHaveLength(64);
        expect(allocated.reduce((sum, entry) => sum + entry.targetAmount, 0)).toBeCloseTo(0.36, 10);
    });

    test('rounds mixed foreign shipping globally and leaves native shipping unchanged', async () => {
        const allocated = await allocateCheckoutAmountsBySource({
            entries: [
                { key: 'native', sourceAmount: 0.01, sourceCurrency: 'USD' },
                { key: 'pkr', sourceAmount: 1, sourceCurrency: 'PKR' },
                { key: 'gbp', sourceAmount: 0.01, sourceCurrency: 'GBP' },
            ],
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        });

        expect(allocated.map(entry => entry.targetAmount)).toEqual([0.01, 0.01, 0.01]);
        expect(allocated.reduce((sum, entry) => sum + entry.targetAmount, 0)).toBeCloseTo(0.03, 10);
    });

    test('rejects unsupported target and source currencies instead of reinterpreting them as USD', async () => {
        await expect(allocateCheckoutAmountsBySource({
            entries: [{ key: 'bad-source', sourceAmount: 10, sourceCurrency: 'CAD' }],
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        })).rejects.toMatchObject({ code: 'CHECKOUT_SOURCE_CURRENCY_NOT_SUPPORTED' });

        await expect(allocateCheckoutAmountsBySource({
            entries: [{ key: 'valid-source', sourceAmount: 10, sourceCurrency: 'USD' }],
            orderCurrency: 'CAD',
            exchangeRates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        })).rejects.toMatchObject({ code: 'ORDER_CURRENCY_NOT_SUPPORTED' });

        await expect(allocateCheckoutAmountsBySource({
            entries: [{ key: 'valid-source', sourceAmount: 10, sourceCurrency: 'USD' }],
            orderCurrency: '',
            exchangeRates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
        })).rejects.toMatchObject({ code: 'ORDER_CURRENCY_NOT_SUPPORTED', statusCode: 400 });
    });

    test('fails closed when foreign shipping has only fallback rates, but allows native shipping', async () => {
        ShippingMethod.find.mockReturnValue(queryResult([{
            seller: 'seller-1',
            methods: [{ type: 'standard', cost: 10, currency: 'PKR', deliveryDays: 4, isActive: true }],
        }]));

        await expect(validateAndPriceShipping({
            requestedSellerShipping: [{ seller: 'seller-1', shippingMethod: { name: 'standard' } }],
            sellerIds: ['seller-1'],
            orderCurrency: 'USD',
            exchangeRates: { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 },
            exchangeRatesFallback: true,
        })).rejects.toMatchObject({ code: 'EXCHANGE_RATES_UNAVAILABLE', statusCode: 503 });

        const nativeResult = await validateAndPriceShipping({
            requestedSellerShipping: [{ seller: 'seller-1', shippingMethod: { name: 'standard' } }],
            sellerIds: ['seller-1'],
            orderCurrency: 'PKR',
            exchangeRates: { USD: 1, PKR: 300, EUR: 0.9, GBP: 0.8 },
            exchangeRatesFallback: true,
        });
        expect(nativeResult.shippingCost).toBe(10);
    });
});

describe('order discount allocation', () => {
    test('preserves each coupon actual amount across different sellers', () => {
        const order = {
            orderItems: [
                { _id: 'line-1', productId: 'product-1', price: 100, quantity: 1 },
                { _id: 'line-2', productId: 'product-2', price: 10, quantity: 1 },
            ],
            orderSummary: { couponDiscount: 20 },
            appliedCoupons: [
                {
                    discountType: 'percentage',
                    discountValue: 50,
                    appliedDiscountAmount: 10,
                    applicableProductIds: ['product-1'],
                },
                {
                    discountType: 'fixed',
                    discountValue: 10,
                    appliedDiscountAmount: 10,
                    applicableProductIds: ['product-2'],
                },
            ],
        };

        const allocations = buildOrderItemDiscountAllocations(order);
        expect(allocations.get('line-1')).toBe(10);
        expect(allocations.get('line-2')).toBe(10);
    });
});
