const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
    buildSellerPaymentSummary,
    buildAdminPaymentsOverviewData,
    quoteWithdrawalAmount,
    quotePayoutAmount,
    assertWithdrawalQuoteCanUseSnapshot,
    isSameWithdrawalRequest,
    canTransitionWithdrawalStatus,
} = require('../../controllers/PaymentController');
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerPaymentRiskHold = require('../../models/SellerPaymentRiskHold');

let mongoServer;

const createUser = (suffix, role = 'user') =>
    User.create({
        username: `${role}${suffix}`,
        email: `${role}${suffix}@test.com`,
        password: 'password123',
        role,
    });

const createProduct = (seller, suffix, price) =>
    Product.create({
        name: `Product ${suffix}`,
        description: `Product ${suffix} description`,
        price,
        category: 'Test',
        brand: 'Test Brand',
        stock: 10,
        image: `https://example.com/${suffix}.jpg`,
        images: [{ url: `https://example.com/${suffix}.jpg` }],
        seller: seller._id,
    });

const shippingInfoFor = (buyer) => ({
    fullName: 'Buyer One',
    email: buyer.email,
    phone: '+923001234567',
    address: '123 Test Street',
    city: 'Lahore',
    state: 'Punjab',
    postalCode: '54000',
    country: 'Pakistan',
});

const createOrder = ({
    buyer,
    items,
    sellerShipping,
    paymentMethod,
    orderStatus = 'pending',
    isPaid = false,
    tax = 0,
    couponDiscount = 0,
    currency = 'USD',
    exchangeRateSnapshot = undefined,
}) => {
    const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
    const shippingCost = sellerShipping.reduce((sum, entry) => sum + entry.shippingMethod.price, 0);

    return Order.create({
        user: buyer._id,
        currency,
        ...(exchangeRateSnapshot ? { exchangeRateSnapshot } : {}),
        orderId: `ORD-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        orderItems: items.map((item) => ({
            productId: item.product._id,
            seller: item.product.seller || null,
            name: item.product.name,
            image: item.product.image,
            price: item.product.price,
            quantity: item.quantity,
        })),
        shippingInfo: shippingInfoFor(buyer),
        shippingMethod: {
            name: 'standard',
            price: shippingCost,
            estimatedDays: 5,
            seller: sellerShipping[0].seller,
        },
        sellerShipping,
        orderSummary: {
            subtotal,
            shippingCost,
            tax,
            couponDiscount,
            totalAmount: subtotal + shippingCost + tax - couponDiscount,
        },
        paymentMethod,
        isPaid,
        paidAt: isPaid ? new Date() : undefined,
        isDelivered: orderStatus === 'delivered',
        deliveredAt: orderStatus === 'delivered' ? new Date() : undefined,
        orderStatus,
    });
};

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
    if (mongoServer) {
        await mongoServer.stop();
    }
}, 60000);

beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        Product.deleteMany({}),
        Order.deleteMany({}),
        SellerPaymentAccount.deleteMany({}),
        SellerWithdrawalRequest.deleteMany({}),
        SellerBalanceTransaction.deleteMany({}),
        SellerPaymentRiskHold.deleteMany({}),
    ]);
});

describe('PaymentController buildSellerPaymentSummary', () => {
    test('only resolves processing through proof, definitive failure, or retained manual review', () => {
        expect(canTransitionWithdrawalStatus('processing', 'paid')).toBe(true);
        expect(canTransitionWithdrawalStatus('processing', 'failed')).toBe(true);
        expect(canTransitionWithdrawalStatus('processing', 'manual_review')).toBe(true);
        expect(canTransitionWithdrawalStatus('processing', 'rejected')).toBe(false);
        expect(canTransitionWithdrawalStatus('processing', 'cancelled')).toBe(false);
        expect(canTransitionWithdrawalStatus('manual_review', 'processing')).toBe(false);
        expect(canTransitionWithdrawalStatus('manual_review', 'failed')).toBe(true);
        expect(canTransitionWithdrawalStatus('failed', 'approved')).toBe(true);
        expect(canTransitionWithdrawalStatus('failed', 'paid')).toBe(false);
        expect(canTransitionWithdrawalStatus('paid', 'processing')).toBe(false);
        expect(canTransitionWithdrawalStatus('rejected', 'paid')).toBe(false);
        expect(canTransitionWithdrawalStatus('cancelled', 'approved')).toBe(false);
    });

    test.each([
        ['non-finite amount', { amountUSD: Number.POSITIVE_INFINITY }],
        ['sub-cent amount', { amountUSD: 1.001 }],
        ['unknown status', { status: 'mystery' }],
        ['unknown direction', { direction: 'sideways' }],
    ])('fails the full balance for a corrupt seller liability %s', async (_label, override) => {
        const seller = await createUser(`corrupt-ledger-${_label}`, 'seller');
        await SellerBalanceTransaction.collection.insertOne({
            seller: seller._id,
            type: 'return_refund',
            direction: 'debit',
            status: 'completed',
            amountUSD: 1,
            sourceAmount: 280,
            sourceCurrency: 'PKR',
            referenceType: 'return_request',
            referenceId: `corrupt-${_label}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...override,
        });

        await expect(buildSellerPaymentSummary(seller._id))
            .rejects.toMatchObject({ code: 'SELLER_FINANCIAL_DATA_INVALID', statusCode: 409 });
    });

    test.each([
        ['non-finite amount', { amount: Number.POSITIVE_INFINITY }],
        ['sub-cent amount', { amount: 5.001 }],
        ['unknown status', { status: 'mystery' }],
        ['non-USD reservation', { currency: 'PKR' }],
        ['sub-cent payout', { payoutAmount: 5.001 }],
    ])('fails the full balance for a corrupt withdrawal %s', async (_label, override) => {
        const seller = await createUser(`corrupt-withdrawal-${_label}`, 'seller');
        await SellerWithdrawalRequest.collection.insertOne({
            seller: seller._id,
            amount: 5,
            currency: 'USD',
            requestedAmount: 5,
            requestedCurrency: 'USD',
            payoutAmount: 5,
            payoutCurrency: 'USD',
            paymentAccountSnapshotVersion: 0,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date(),
            ...override,
        });

        await expect(buildSellerPaymentSummary(seller._id))
            .rejects.toMatchObject({ code: 'SELLER_FINANCIAL_DATA_INVALID', statusCode: 409 });
    });

    test('separates Stripe withdrawable revenue, COD revenue, pending estimates, and withdrawal reservations', async () => {
        const seller = await createUser('seller', 'seller');
        const otherSeller = await createUser('otherseller', 'seller');
        const buyer = await createUser('buyer', 'user');
        const sellerProduct = await createProduct(seller, 'seller', 100);
        const otherProduct = await createProduct(otherSeller, 'other', 50);

        await createOrder({
            buyer,
            items: [
                { product: sellerProduct, quantity: 2 },
                { product: otherProduct, quantity: 1 },
            ],
            sellerShipping: [
                { seller: seller._id, shippingMethod: { name: 'standard', price: 8, estimatedDays: 5 } },
                { seller: otherSeller._id, shippingMethod: { name: 'standard', price: 4, estimatedDays: 5 } },
            ],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
            tax: 25,
            couponDiscount: 10,
        });

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 3 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 7, estimatedDays: 5 } }],
            paymentMethod: 'cash_on_delivery',
            isPaid: false,
            orderStatus: 'delivered',
        });

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 2, estimatedDays: 5 } }],
            paymentMethod: 'cash_on_delivery',
            isPaid: false,
            orderStatus: 'pending',
        });

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 4, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'processing',
        });

        await SellerWithdrawalRequest.create([
            { seller: seller._id, amount: 50, status: 'pending' },
            { seller: seller._id, amount: 15, status: 'approved' },
            { seller: seller._id, amount: 25, status: 'paid' },
        ]);

        const summary = await buildSellerPaymentSummary(seller._id);

        expect(summary.revenue.stripeDeliveredRevenue).toBe(220);
        expect(summary.revenue.codDeliveredRevenue).toBe(307);
        expect(summary.revenue.codPendingRevenue).toBe(102);
        expect(summary.revenue.stripePendingRevenue).toBe(104);
        expect(summary.revenue.pendingWithdrawalAmount).toBe(50);
        expect(summary.revenue.approvedWithdrawalAmount).toBe(15);
        expect(summary.revenue.totalWithdrawn).toBe(25);
        expect(summary.revenue.withdrawableBalance).toBe(130);
        expect(summary.revenue.totalDeliveredRevenue).toBe(527);
        expect(summary.revenue.estimatedRevenue).toBe(733);
    });

    test('converts non-USD order revenue to USD before exposing seller balances', async () => {
        const seller = await createUser('sellerpkr', 'seller');
        const buyer = await createUser('buyerpkr', 'user');
        const sellerProduct = await createProduct(seller, 'pkr', 2800);

        const rateSnapshot = {
            base: 'USD',
            rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
            capturedAt: new Date().toISOString(),
            source: 'checkout-test',
            fallback: false,
        };

        await createOrder({
            buyer,
            currency: 'PKR',
            exchangeRateSnapshot: rateSnapshot,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });

        const expectedUSD = 10;
        const summary = await buildSellerPaymentSummary(seller._id, { rateSnapshot });

        expect(summary.revenue.stripeDeliveredRevenue).toBe(expectedUSD);
        expect(summary.revenue.withdrawableBalance).toBe(expectedUSD);
        expect(summary.displayCurrency).toBe('USD');
        expect(summary.recentStripeOrders[0]).toMatchObject({
            amount: expectedUSD,
            amountCurrency: 'USD',
            sourceAmount: 2800,
            sourceCurrency: 'PKR',
        });

        const pkrSummary = await buildSellerPaymentSummary(seller._id, {
            displayCurrency: 'PKR',
            rateSnapshot,
        });
        expect(pkrSummary.displayRevenue.withdrawableBalance).toBe(2800);
        expect(pkrSummary.withdrawalLimits.availableDisplayAmount).toBe(2800);
    });

    test('rounds mixed-currency live display revenue once across all source currencies', async () => {
        const seller = await createUser('mixeddisplay', 'seller');
        const buyer = await createUser('mixeddisplaybuyer', 'user');
        const pkrProduct = await createProduct(seller, 'mixeddisplaypkr', 1);
        const gbpProduct = await createProduct(seller, 'mixeddisplaygbp', 0.01);
        const rateSnapshot = {
            base: 'USD',
            rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
            capturedAt: new Date().toISOString(),
            source: 'live-test',
            fallback: false,
        };

        await createOrder({
            buyer,
            currency: 'PKR',
            exchangeRateSnapshot: rateSnapshot,
            items: [{ product: pkrProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });
        await createOrder({
            buyer,
            currency: 'GBP',
            exchangeRateSnapshot: rateSnapshot,
            items: [{ product: gbpProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });

        const summary = await buildSellerPaymentSummary(seller._id, {
            displayCurrency: 'USD',
            rateSnapshot,
        });

        expect(summary.displayRevenue.stripeDeliveredRevenue).toBe(0.02);
        expect(summary.displayRevenue.withdrawableBalance).toBe(0.02);
        // Canonical settlement intentionally retains its per-order cent
        // boundaries so future full refunds cancel the exact credited ledger.
        expect(summary.revenue.withdrawableBalance).toBe(0.01);
    });

    test('allows an outage-safe USD balance without using fallback FX', async () => {
        const seller = await createUser('fallbackusd', 'seller');
        const buyer = await createUser('fallbackusdbuyer', 'user');
        const product = await createProduct(seller, 'fallbackusd', 25);
        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
            currency: 'USD',
        });

        const fallbackSnapshot = {
            base: 'USD',
            rates: { USD: 1, PKR: 999, EUR: 9, GBP: 8 },
            capturedAt: new Date().toISOString(),
            source: 'fallback',
            fallback: true,
        };
        const summary = await buildSellerPaymentSummary(seller._id, {
            displayCurrency: 'USD',
            rateSnapshot: fallbackSnapshot,
        });

        expect(summary.exchangeRateStatus.fallback).toBe(true);
        expect(summary.revenue.withdrawableBalance).toBe(25);
        expect(summary.withdrawalLimits.availableDisplayAmount).toBe(25);
    });

    test('quarantines a legacy foreign-currency balance instead of freezing the current live rate', async () => {
        const seller = await createUser('fallbacklegacy', 'seller');
        const buyer = await createUser('fallbacklegacybuyer', 'user');
        const product = await createProduct(seller, 'fallbacklegacy', 2500);
        const legacyOrder = await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
            currency: 'PKR',
        });

        await expect(buildSellerPaymentSummary(seller._id, {
            displayCurrency: 'USD',
            rateSnapshot: {
                base: 'USD',
                rates: { USD: 1, PKR: 999, EUR: 9, GBP: 8 },
                capturedAt: new Date().toISOString(),
                source: 'current-live-rate',
                fallback: false,
            },
        })).rejects.toMatchObject({
            statusCode: 409,
            code: 'LEGACY_ORDER_FX_BACKFILL_REQUIRED',
        });
        const persisted = await Order.findById(legacyOrder._id).lean();
        expect(persisted.exchangeRateSnapshot?.rates?.PKR).toBeNull();
        expect(persisted.sellerSettlementVersion).toBe(0);
    });

    test('uses a trusted checkout snapshot for foreign revenue during a live-rate outage', async () => {
        const seller = await createUser('fallbackfrozen', 'seller');
        const buyer = await createUser('fallbackfrozenbuyer', 'user');
        const product = await createProduct(seller, 'fallbackfrozen', 2500);
        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
            currency: 'PKR',
            exchangeRateSnapshot: {
                base: 'USD',
                rates: { USD: 1, PKR: 250, EUR: 0.9, GBP: 0.8 },
                capturedAt: new Date(),
                source: 'checkout',
                fallback: false,
            },
        });

        const summary = await buildSellerPaymentSummary(seller._id, {
            displayCurrency: 'USD',
            rateSnapshot: {
                base: 'USD',
                rates: { USD: 1, PKR: 999, EUR: 9, GBP: 8 },
                capturedAt: new Date().toISOString(),
                source: 'fallback',
                fallback: true,
            },
        });

        expect(summary.revenue.withdrawableBalance).toBe(10);
        expect(summary.withdrawalLimits.availableDisplayAmount).toBe(10);
    });

    test.each([
        { livePkrRate: 300, expectedAvailablePkr: 3000 },
        { livePkrRate: 260, expectedAvailablePkr: 2600 },
    ])(
        'quotes canonical withdrawal capacity at live PKR $livePkrRate without changing native reporting',
        async ({ livePkrRate, expectedAvailablePkr }) => {
            const seller = await createUser(`withdrawquote${livePkrRate}`, 'seller');
            const buyer = await createUser(`withdrawquotebuyer${livePkrRate}`, 'user');
            const product = await createProduct(seller, `withdrawquote${livePkrRate}`, 2800);
            await createOrder({
                buyer,
                items: [{ product, quantity: 1 }],
                sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
                paymentMethod: 'stripe',
                isPaid: true,
                orderStatus: 'delivered',
                currency: 'PKR',
                exchangeRateSnapshot: {
                    base: 'USD',
                    rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
                    capturedAt: new Date(),
                    source: 'checkout',
                    fallback: false,
                },
            });

            const summary = await buildSellerPaymentSummary(seller._id, {
                displayCurrency: 'PKR',
                rateSnapshot: {
                    base: 'USD',
                    rates: { USD: 1, PKR: livePkrRate, EUR: 0.9, GBP: 0.8 },
                    capturedAt: new Date().toISOString(),
                    source: 'live-test',
                    fallback: false,
                },
            });

            expect(summary.revenue.withdrawableBalance).toBe(10);
            expect(summary.displayRevenue.withdrawableBalance).toBe(2800);
            expect(summary.withdrawalLimits.availableDisplayAmount).toBe(expectedAvailablePkr);
        }
    );

    test('never creates money when one cent of tax is split across sellers', async () => {
        const sellerA = await createUser('centa', 'seller');
        const sellerB = await createUser('centb', 'seller');
        const buyer = await createUser('centbuyer', 'user');
        const productA = await createProduct(sellerA, 'centa', 0.01);
        const productB = await createProduct(sellerB, 'centb', 0.01);

        await createOrder({
            buyer,
            items: [
                { product: productA, quantity: 1 },
                { product: productB, quantity: 1 },
            ],
            sellerShipping: [
                { seller: sellerA._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } },
                { seller: sellerB._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } },
            ],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
            tax: 0.01,
        });

        const [summaryA, summaryB] = await Promise.all([
            buildSellerPaymentSummary(sellerA._id),
            buildSellerPaymentSummary(sellerB._id),
        ]);
        expect(summaryA.revenue.withdrawableBalance + summaryB.revenue.withdrawableBalance).toBe(0.03);
    });

    test('makes delivered Wallet funds withdrawable while COD remains seller-collected', async () => {
        const seller = await createUser('walletseller', 'seller');
        const buyer = await createUser('walletbuyer', 'user');
        const product = await createProduct(seller, 'walletproduct', 100);

        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 5, estimatedDays: 5 } }],
            paymentMethod: 'wallet',
            isPaid: true,
            orderStatus: 'delivered',
        });
        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 2, estimatedDays: 5 } }],
            paymentMethod: 'wallet',
            isPaid: true,
            orderStatus: 'processing',
        });
        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 3, estimatedDays: 5 } }],
            paymentMethod: 'cash_on_delivery',
            isPaid: false,
            orderStatus: 'delivered',
        });

        const summary = await buildSellerPaymentSummary(seller._id);
        expect(summary.revenue.walletDeliveredRevenue).toBe(105);
        expect(summary.revenue.walletPendingRevenue).toBe(102);
        expect(summary.revenue.codDeliveredRevenue).toBe(103);
        expect(summary.revenue.onlineDeliveredRevenue).toBe(105);
        expect(summary.revenue.withdrawableBalance).toBe(105);
        expect(summary.revenue.totalDeliveredRevenue).toBe(208);
        expect(summary.revenue.estimatedRevenue).toBe(310);
    });

    test('derives withdrawal USD on the server and ignores a forged client amountUSD', () => {
        const rates = { USD: 1, PKR: 250, EUR: 0.9, GBP: 0.8 };
        const quote = quoteWithdrawalAmount({
            body: { amount: 2500, currency: 'PKR', amountUSD: 999999 },
            userCurrency: 'PKR',
            rates,
        });

        expect(quote).toEqual({
            requestedAmount: 2500,
            requestedCurrency: 'PKR',
            amountUSD: 10,
        });
    });

    test('uses the same cent-rounded native amount for the saved request and USD reservation', () => {
        const rates = { USD: 1, PKR: 2, EUR: 0.9, GBP: 0.8 };
        const quote = quoteWithdrawalAmount({
            body: { requestedAmount: '1.006', requestedCurrency: 'PKR' },
            userCurrency: 'PKR',
            rates,
        });

        expect(quote).toEqual({
            requestedAmount: 1.01,
            requestedCurrency: 'PKR',
            amountUSD: 0.51,
        });
        expect(() => quoteWithdrawalAmount({
            body: { requestedAmount: true, requestedCurrency: 'PKR' },
            rates,
        })).toThrow('Withdrawal amount must be greater than zero');
        expect(() => quoteWithdrawalAmount({
            body: { requestedAmount: [10], requestedCurrency: 'PKR' },
            rates,
        })).toThrow('Withdrawal amount must be greater than zero');
        for (const requestedCurrency of [false, '', '   ', {}, []]) {
            expect(() => quoteWithdrawalAmount({
                body: { requestedAmount: 10, requestedCurrency },
                userCurrency: 'USD',
                rates,
            })).toThrow('Choose a supported withdrawal currency');
        }
    });

    test('freezes the bank payout in the saved account currency', () => {
        const rates = { USD: 1, PKR: 250, EUR: 0.9, GBP: 0.8 };
        expect(quotePayoutAmount(10, 'PKR', rates)).toEqual({
            payoutAmount: 2500,
            payoutCurrency: 'PKR',
        });
        expect(quotePayoutAmount(10, 'USD', rates)).toEqual({
            payoutAmount: 10,
            payoutCurrency: 'USD',
        });
    });

    test('permits fallback only when both withdrawal quote legs are USD', () => {
        const fallbackSnapshot = {
            rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
            fallback: true,
        };
        expect(() => assertWithdrawalQuoteCanUseSnapshot(
            fallbackSnapshot,
            'USD',
            'USD'
        )).not.toThrow();
        for (const [requestedCurrency, payoutCurrency] of [
            ['PKR', 'USD'],
            ['USD', 'PKR'],
            ['PKR', 'PKR'],
        ]) {
            expect(() => assertWithdrawalQuoteCanUseSnapshot(
                fallbackSnapshot,
                requestedCurrency,
                payoutCurrency
            )).toThrow(expect.objectContaining({
                statusCode: 503,
                code: 'EXCHANGE_RATES_UNAVAILABLE',
            }));
        }
    });

    test('reuses a withdrawal key only for the same rounded amount and currency', () => {
        const existing = { requestedAmount: 2500, requestedCurrency: 'PKR' };
        expect(isSameWithdrawalRequest(existing, '2500.00', 'pkr')).toBe(true);
        expect(isSameWithdrawalRequest(existing, 2500.01, 'PKR')).toBe(false);
        expect(isSameWithdrawalRequest(existing, 2500, 'USD')).toBe(false);
        expect(isSameWithdrawalRequest(existing, true, 'PKR')).toBe(false);
    });

    test('builds admin overview in bulk and uses order item seller snapshots', async () => {
        const seller = await createUser('snapshot', 'seller');
        const buyer = await createUser('snapshotbuyer', 'user');
        const sellerProduct = await createProduct(seller, 'snapshot', 50);

        await createOrder({
            buyer,
            items: [{ product: sellerProduct, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });
        await Product.deleteOne({ _id: sellerProduct._id });

        await SellerPaymentAccount.create({
            seller: seller._id,
            accountHolderName: 'Snapshot Seller',
            bankName: 'Test Bank',
            accountNumber: '1234567890',
            accountNumberLast4: '7890',
        });
        await SellerWithdrawalRequest.create({ seller: seller._id, amount: 5, status: 'pending' });

        const overview = await buildAdminPaymentsOverviewData();
        const row = overview.sellers.find((sellerRow) => sellerRow.seller.email === seller.email);

        expect(row).toBeTruthy();
        expect(row.revenue.stripeDeliveredRevenue).toBe(50);
        expect(row.revenue.pendingWithdrawalAmount).toBe(5);
        expect(row.revenue.withdrawableBalance).toBe(45);
        expect(row.paymentAccount.accountNumber).toBe('1234567890');
        expect(overview.summary.stripeDeliveredRevenue).toBe(50);
        expect(overview.summary.withdrawableBalance).toBe(45);
        expect(overview.withdrawals).toHaveLength(1);
    });

    test('applies pending payment risk holds to admin seller rows and aggregate withdrawable totals', async () => {
        const seller = await createUser('adminriskhold', 'seller');
        const unheldSeller = await createUser('adminriskunheld', 'seller');
        const buyer = await createUser('adminriskholdbuyer', 'user');
        const product = await createProduct(seller, 'adminriskhold', 50);
        const unheldProduct = await createProduct(unheldSeller, 'adminriskunheld', 30);

        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: seller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });
        await SellerPaymentRiskHold.create({
            seller: seller._id,
            sourceType: 'order_payment',
            sourceReferenceId: 'admin-risk-order',
            paymentIntentId: 'pi_admin_risk',
            chargeId: 'ch_admin_risk',
            eventId: 'evt_admin_risk',
            eventType: 'charge.refund.updated',
            riskTrack: 'refund',
            riskTrackKey: 'refund',
            status: 'pending',
        });
        await createOrder({
            buyer,
            items: [{ product: unheldProduct, quantity: 1 }],
            sellerShipping: [{ seller: unheldSeller._id, shippingMethod: { name: 'free', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'wallet',
            isPaid: true,
            orderStatus: 'delivered',
        });

        const overview = await buildAdminPaymentsOverviewData();
        const row = overview.sellers.find(
            sellerRow => sellerRow.seller._id.toString() === seller._id.toString()
        );

        expect(row.paymentRiskPending).toBe(true);
        expect(row.paymentRiskHoldCount).toBe(1);
        expect(row.revenue.withdrawableBalance).toBe(0);
        expect(row.revenue.paymentRiskHeldAmount).toBe(50);
        const unheldRow = overview.sellers.find(
            sellerRow => sellerRow.seller._id.toString() === unheldSeller._id.toString()
        );
        expect(unheldRow.paymentRiskPending).toBe(false);
        expect(unheldRow.revenue.withdrawableBalance).toBe(30);
        expect(unheldRow.revenue.paymentRiskHeldAmount).toBe(0);
        expect(overview.summary.withdrawableBalance).toBe(30);
        expect(overview.summary.paymentRiskHeldAmount).toBe(50);
    });

    test('treats the checkout seller snapshot as authoritative after product ownership changes', async () => {
        const originalSeller = await createUser('originalsnapshot', 'seller');
        const currentOwner = await createUser('currentowner', 'seller');
        const buyer = await createUser('snapshottransferbuyer', 'user');
        const product = await createProduct(originalSeller, 'transferred', 75);

        await createOrder({
            buyer,
            items: [{ product, quantity: 1 }],
            sellerShipping: [{ seller: originalSeller._id, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } }],
            paymentMethod: 'stripe',
            isPaid: true,
            orderStatus: 'delivered',
        });

        await Product.updateOne({ _id: product._id }, { seller: currentOwner._id });

        const [originalSummary, currentOwnerSummary] = await Promise.all([
            buildSellerPaymentSummary(originalSeller._id),
            buildSellerPaymentSummary(currentOwner._id),
        ]);

        expect(originalSummary.revenue.stripeDeliveredRevenue).toBe(75);
        expect(currentOwnerSummary.revenue.stripeDeliveredRevenue).toBe(0);
        expect(currentOwnerSummary.revenue.totalRelevantOrders).toBe(0);
    });
});
