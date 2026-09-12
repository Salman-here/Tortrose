jest.mock('../../services/currencyService', () => ({
    ...jest.requireActual('../../services/currencyService'),
    getExchangeRateSnapshot: jest.fn(),
}));

jest.mock('../../services/walletService', () => ({
    ...jest.requireActual('../../services/walletService'),
    runInTransaction: jest.fn(async (work) => work(null)),
}));

jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
    notifySeller: jest.fn(async () => {}),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getExchangeRateSnapshot } = require('../../services/currencyService');
const { createWithdrawalRequest } = require('../../controllers/PaymentController');
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');

let mongoServer;
let consoleError;
let previousPayoutEncryptionKey;
let previousPayoutEncryptionKeyId;

const fallbackSnapshot = () => ({
    base: 'USD',
    rates: { USD: 1, PKR: 999, EUR: 9, GBP: 8 },
    capturedAt: new Date().toISOString(),
    source: 'fallback',
    fallback: true,
});

let withdrawalKeySequence = 0;
const invokeWithdrawal = async (seller, body, {
    idempotencyKey = `withdrawal-fallback-test-${++withdrawalKeySequence}`,
} = {}) => {
    const req = {
        user: {
            id: seller._id.toString(),
            role: 'seller',
            username: seller.username,
            currency: 'USD',
        },
        body,
        get: header => (
            String(header || '').toLowerCase() === 'idempotency-key'
                ? idempotencyKey
                : ''
        ),
    };
    const response = { statusCode: 200, body: null };
    const res = {
        status(code) {
            response.statusCode = code;
            return this;
        },
        json(payload) {
            response.body = payload;
            return this;
        },
    };
    await createWithdrawalRequest(req, res);
    return response;
};

const seedSellerOrder = async ({
    currency = 'USD',
    accountCurrency = 'USD',
    orderAmount = currency === 'USD' ? 25 : 2500,
} = {}) => {
    const seller = await User.create({
        username: `seller-${currency}-${Date.now()}`,
        email: `seller-${currency}-${Date.now()}@test.com`,
        password: 'password123',
        role: 'seller',
        currency: 'USD',
    });
    const buyer = await User.create({
        username: `buyer-${currency}-${Date.now()}`,
        email: `buyer-${currency}-${Date.now()}@test.com`,
        password: 'password123',
        role: 'user',
    });
    const product = await Product.create({
        name: `Fallback ${currency} product`,
        description: 'Fallback withdrawal regression product',
        price: orderAmount,
        category: 'Test',
        brand: 'Test Brand',
        stock: 10,
        image: 'https://example.com/fallback.jpg',
        images: [{ url: 'https://example.com/fallback.jpg' }],
        seller: seller._id,
    });
    const amount = product.price;
    await Order.create({
        user: buyer._id,
        currency,
        orderId: `ORD-FALLBACK-${currency}-${Date.now()}`,
        orderItems: [{
            productId: product._id,
            seller: seller._id,
            name: product.name,
            image: product.image,
            price: amount,
            lineSubtotal: amount,
            quantity: 1,
        }],
        shippingInfo: {
            fullName: 'Fallback Buyer',
            email: buyer.email,
            phone: '+923001234567',
            address: '123 Test Street',
            city: 'Lahore',
            state: 'Punjab',
            postalCode: '54000',
            country: 'Pakistan',
        },
        shippingMethod: {
            name: 'free',
            price: 0,
            estimatedDays: 5,
            seller: seller._id,
        },
        sellerShipping: [{
            seller: seller._id,
            shippingMethod: { name: 'free', price: 0, estimatedDays: 5 },
        }],
        orderSummary: {
            subtotal: amount,
            shippingCost: 0,
            tax: 0,
            couponDiscount: 0,
            totalAmount: amount,
        },
        paymentMethod: 'stripe',
        isPaid: true,
        paidAt: new Date(),
        orderStatus: 'delivered',
        isDelivered: true,
        deliveredAt: new Date(),
    });
    await SellerPaymentAccount.create({
        seller: seller._id,
        accountHolderName: 'Fallback Seller',
        bankName: 'Test Bank',
        accountNumber: '000000001234',
        accountNumberLast4: '1234',
        country: 'Pakistan',
        countryCode: 'PK',
        currency: accountCurrency,
        isActive: true,
    });
    return seller;
};

beforeAll(async () => {
    previousPayoutEncryptionKey = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    previousPayoutEncryptionKeyId = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = 'fallback-test-v1';
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
    if (previousPayoutEncryptionKey === undefined) delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = previousPayoutEncryptionKey;
    if (previousPayoutEncryptionKeyId === undefined) delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;
    else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = previousPayoutEncryptionKeyId;
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    getExchangeRateSnapshot.mockResolvedValue(fallbackSnapshot());
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    consoleError?.mockRestore();
});

describe('PaymentController withdrawal fallback behavior', () => {
    test('rejects a withdrawal without an idempotency key before reserving any balance', async () => {
        const seller = await seedSellerOrder({ orderAmount: 10 });

        const response = await invokeWithdrawal(seller, {
            amount: 5,
            currency: 'USD',
        }, { idempotencyKey: '' });

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({ code: 'WITHDRAWAL_IDEMPOTENCY_KEY_REQUIRED' });
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });

    test.each([5.19, 5])('withdraws exact native USD %s without a currency round trip', async amount => {
        const seller = await seedSellerOrder({ orderAmount: 5.19 });
        const response = await invokeWithdrawal(seller, { requestedAmount: amount, requestedCurrency: 'USD' });
        expect(response.statusCode).toBe(201);
        expect(response.body).toMatchObject({ amount, currency: 'USD', requestedAmount: amount, requestedCurrency: 'USD', payoutAmount: amount, payoutCurrency: 'USD' });
        const saved = await SellerWithdrawalRequest.findOne({ seller: seller._id }).lean();
        expect(saved).toMatchObject({ amount, currency: 'USD', balanceVersion: 2, exchangeRateSnapshot: null });
    });

    test('does not let full-balance round-trip clamping bypass the canonical USD minimum', async () => {
        getExchangeRateSnapshot.mockResolvedValue({
            base: 'USD',
            rates: { USD: 1, PKR: 280, EUR: 0.5, GBP: 0.8 },
            capturedAt: new Date().toISOString(),
            source: 'live-test',
            fallback: false,
        });
        const seller = await seedSellerOrder({ orderAmount: 4.99 });

        const response = await invokeWithdrawal(seller, {
            requestedAmount: 2.5,
            requestedCurrency: 'EUR',
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({ code: 'WITHDRAWAL_MINIMUM_NOT_MET' });
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });

    test('advertises a fixed GBP minimum independent of rate movements, with no automatic conversion', async () => {
        const seller = await seedSellerOrder({ orderAmount: 10 });
        const below = await invokeWithdrawal(seller, { requestedAmount: 4.99, requestedCurrency: 'GBP' });
        expect(below.statusCode).toBe(400);
        expect(below.body).toMatchObject({ minimumRequestedAmount: 5, requestedCurrency: 'GBP' });
        const mismatch = await invokeWithdrawal(seller, { requestedAmount: 5, requestedCurrency: 'GBP' });
        expect(mismatch.statusCode).toBe(400);
        expect(mismatch.body.code).toBe('WITHDRAWAL_BANK_CURRENCY_MISMATCH');
        expect(await SellerWithdrawalRequest.countDocuments({})).toBe(0);
    });

    test('creates a USD-requested, USD-payout withdrawal during a provider outage', async () => {
        const seller = await seedSellerOrder();

        const response = await invokeWithdrawal(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        });

        expect(response.statusCode).toBe(201);
        expect(response.body).toMatchObject({
            success: true,
            amount: 10,
            currency: 'USD',
            requestedAmount: 10,
            requestedCurrency: 'USD',
            payoutAmount: 10,
            payoutCurrency: 'USD',
        });
        const saved = await SellerWithdrawalRequest.findOne({ seller: seller._id }).lean();
        expect(saved).toMatchObject({
            amount: 10,
            requestedCurrency: 'USD',
            payoutCurrency: 'USD',
            exchangeRateSnapshot: null,
            balanceVersion: 2,
        });

    });

    test('does not reserve a withdrawal when a legacy PKR order needs audited FX backfill', async () => {
        const seller = await seedSellerOrder({ currency: 'PKR' });

        const response = await invokeWithdrawal(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        });

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({ code: 'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING' });
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });

    test('rejects a non-USD bank payout before any fallback quote is persisted', async () => {
        const seller = await seedSellerOrder({ accountCurrency: 'PKR' });

        const response = await invokeWithdrawal(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({ code: 'WITHDRAWAL_BANK_CURRENCY_MISMATCH' });
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });

    test('rejects a non-USD requested amount before fallback can set its USD reservation', async () => {
        const seller = await seedSellerOrder();

        const response = await invokeWithdrawal(seller, {
            requestedAmount: 2500,
            requestedCurrency: 'PKR',
        });

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({ code: 'WITHDRAWAL_BANK_CURRENCY_MISMATCH' });
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });
});
