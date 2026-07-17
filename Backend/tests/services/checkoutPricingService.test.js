'use strict';

jest.mock('../../models/Coupon', () => ({ find: jest.fn() }));
jest.mock('../../models/ShippingMethod', () => ({ find: jest.fn() }));
jest.mock('../../services/currencyService', () => ({
    normalizeCurrency: value => String(value || 'USD').toUpperCase(),
    convertAmount: jest.fn(async (amount, from, to) => {
        const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
        return (Number(amount) / rates[String(from).toUpperCase()]) * rates[String(to).toUpperCase()];
    }),
}));

const Coupon = require('../../models/Coupon');
const ShippingMethod = require('../../models/ShippingMethod');
const {
    validateAndPriceCoupons,
    validateAndPriceShipping,
} = require('../../services/checkoutPricingService');
const { buildOrderItemDiscountAllocations } = require('../../services/orderDiscountService');

const queryResult = value => ({ lean: jest.fn().mockResolvedValue(value) });
const COUPON_ID = '64b000000000000000000001';

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
        });
    });

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
