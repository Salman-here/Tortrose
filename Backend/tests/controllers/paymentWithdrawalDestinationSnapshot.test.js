jest.mock('../../services/currencyService', () => ({
    ...jest.requireActual('../../services/currencyService'),
    getExchangeRateSnapshot: jest.fn(),
}));

jest.mock('../../services/walletService', () => ({
    ...jest.requireActual('../../services/walletService'),
    runInTransaction: jest.fn(async work => work(null)),
}));

jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
    notifySeller: jest.fn(async () => {}),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { getExchangeRateSnapshot } = require('../../services/currencyService');
const {
    createWithdrawalRequest,
    getSellerWithdrawals,
    buildAdminPaymentsOverviewData,
    updateWithdrawalRequestStatus,
    upsertSellerPaymentAccount,
} = require('../../controllers/PaymentController');
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Notification = require('../../models/Notification');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');
const SellerPaymentRiskHold = require('../../models/SellerPaymentRiskHold');
const NotificationOutbox = require('../../models/NotificationOutbox');

let mongoServer;
let originalKey;
let originalKeyId;

const trustedRates = {
    base: 'USD',
    rates: { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.8 },
    capturedAt: new Date().toISOString(),
    source: 'snapshot-test',
    fallback: false,
};

const responseRecorder = () => {
    const response = { statusCode: 200, body: null };
    response.res = {
        status(code) {
            response.statusCode = code;
            return this;
        },
        json(payload) {
            response.body = payload;
            return this;
        },
    };
    return response;
};

const sellerRequest = (seller, body = {}, extras = {}) => ({
    user: {
        id: seller._id.toString(),
        role: 'seller',
        username: seller.username,
        currency: seller.currency || 'USD',
    },
    body,
    query: {},
    params: {},
    get: header => (
        String(header || '').toLowerCase() === 'idempotency-key'
            ? extras.idempotencyKey || 'destination-snapshot-request'
            : ''
    ),
});

const adminTransition = async (admin, withdrawalId, body, operationKey) => {
    const response = responseRecorder();
    await updateWithdrawalRequestStatus({
        user: { id: admin._id.toString(), role: 'admin' },
        params: { id: withdrawalId.toString() },
        body,
        get: header => (
            String(header || '').toLowerCase() === 'idempotency-key' ? operationKey : ''
        ),
    }, response.res);
    return response;
};

const seedSellerRevenue = async () => {
    const seller = await User.create({
        username: 'snapshot-seller',
        email: 'snapshot-seller@test.com',
        password: 'password123',
        role: 'seller',
        currency: 'USD',
    });
    const buyer = await User.create({
        username: 'snapshot-buyer',
        email: 'snapshot-buyer@test.com',
        password: 'password123',
        role: 'user',
    });
    const product = await Product.create({
        name: 'Snapshot product',
        description: 'Payout destination snapshot test product',
        price: 50,
        category: 'Test',
        brand: 'Test',
        stock: 10,
        image: 'https://example.com/snapshot.jpg',
        images: [{ url: 'https://example.com/snapshot.jpg' }],
        seller: seller._id,
    });
    await Order.create({
        user: buyer._id,
        currency: 'USD',
        exchangeRateSnapshot: trustedRates,
        orderId: `ORD-PAYOUT-SNAPSHOT-${Date.now()}`,
        orderItems: [{
            productId: product._id,
            seller: seller._id,
            name: product.name,
            image: product.image,
            price: 50,
            lineSubtotal: 50,
            quantity: 1,
        }],
        shippingInfo: {
            fullName: 'Snapshot Buyer',
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
            subtotal: 50,
            shippingCost: 0,
            tax: 0,
            couponDiscount: 0,
            totalAmount: 50,
        },
        paymentMethod: 'stripe',
        isPaid: true,
        paidAt: new Date(),
        orderStatus: 'delivered',
        isDelivered: true,
        deliveredAt: new Date(),
    });
    return seller;
};

const seedPayoutAccount = (seller, overrides = {}) => SellerPaymentAccount.create({
    seller: seller._id,
    accountHolderName: 'Frozen Account Holder',
    bankName: 'Frozen Account Bank',
    accountNumber: '001122334455',
    accountNumberLast4: '4455',
    iban: 'PK02FROZ0000000044550000',
    ibanLast4: '4455',
    swiftCode: 'FROZPKKA',
    country: 'Pakistan',
    currency: 'PKR',
    payoutInstructions: 'Frozen account only',
    isActive: true,
    ...overrides,
});

beforeAll(async () => {
    originalKey = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    originalKeyId = process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
    process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = 'test-v1';
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
}, 60000);

afterAll(async () => {
    if (originalKey === undefined) delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY;
    else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = originalKey;
    if (originalKeyId === undefined) delete process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID;
    else process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY_ID = originalKeyId;
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
}, 60000);

beforeEach(async () => {
    jest.clearAllMocks();
    getExchangeRateSnapshot.mockResolvedValue({
        ...trustedRates,
        capturedAt: new Date().toISOString(),
    });
    await Promise.all([
        User.deleteMany({}),
        Product.deleteMany({}),
        Order.deleteMany({}),
        Notification.deleteMany({}),
        SellerPaymentAccount.deleteMany({}),
        SellerWithdrawalRequest.deleteMany({}),
        SellerPaymentRiskHold.deleteMany({}),
        NotificationOutbox.deleteMany({}),
    ]);
});

describe('withdrawal payout destination snapshots', () => {
    test('requires an encrypted envelope whenever a request claims the secure snapshot version', async () => {
        const request = new SellerWithdrawalRequest({
            seller: new mongoose.Types.ObjectId(),
            amount: 5,
            paymentAccountSnapshotVersion: 1,
        });

        await expect(request.validate()).rejects.toMatchObject({
            errors: expect.objectContaining({
                paymentAccountSnapshotEnvelope: expect.anything(),
            }),
        });
    });

    test('freezes account A across same-last4 account replacement and redacts seller payloads', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'snapshot-admin',
            email: 'snapshot-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        const accountANumber = '001111111234';
        const accountAIBAN = 'PK48AAAA0000000000001234';
        const accountBNumber = '009999991234';
        const accountBIBAN = 'PK14BBBB0000000099991234';

        await SellerPaymentAccount.create({
            seller: seller._id,
            accountHolderName: 'Account A Holder',
            bankName: 'Account A Bank',
            accountNumber: accountANumber,
            accountNumberLast4: '1234',
            iban: accountAIBAN,
            ibanLast4: '1234',
            swiftCode: 'AAAAPKKA',
            country: 'Pakistan',
            currency: 'PKR',
            payoutInstructions: 'Account A branch 001',
            isActive: true,
        });

        const createResponse = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        }), createResponse.res);

        expect(createResponse.statusCode).toBe(201);
        expect(createResponse.body.withdrawal.paymentAccountSnapshot).toMatchObject({
            accountNumberLast4: '1234',
            ibanLast4: '1234',
            snapshotStatus: 'complete',
            payoutBlocked: false,
        });
        const sellerCreatePayload = JSON.stringify(createResponse.body);
        expect(sellerCreatePayload).not.toContain(accountANumber);
        expect(sellerCreatePayload).not.toContain(accountAIBAN);
        expect(sellerCreatePayload).not.toContain('paymentAccountSnapshotEnvelope');

        const defaultRead = await SellerWithdrawalRequest.findOne({ seller: seller._id }).lean();
        expect(defaultRead.paymentAccountSnapshotEnvelope).toBeUndefined();
        const protectedRead = await SellerWithdrawalRequest.findOne({ seller: seller._id })
            .select('+paymentAccountSnapshotEnvelope')
            .lean();
        expect(protectedRead.paymentAccountSnapshotVersion).toBe(1);
        expect(protectedRead.paymentAccountSnapshotEnvelope).toEqual(expect.any(String));
        expect(JSON.stringify(protectedRead)).not.toContain(accountANumber);
        expect(JSON.stringify(protectedRead)).not.toContain(accountAIBAN);

        await SellerWithdrawalRequest.updateOne(
            { _id: protectedRead._id },
            {
                $set: {
                    'paymentAccountSnapshot.bankName': 'Tampered Bank',
                    paymentAccountSnapshotEnvelope: 'tampered-envelope',
                    paymentAccountSnapshotVersion: 0,
                },
            }
        );
        const immutableRead = await SellerWithdrawalRequest.findById(protectedRead._id)
            .select('+paymentAccountSnapshotEnvelope')
            .lean();
        expect(immutableRead.paymentAccountSnapshot.bankName).toBe('Account A Bank');
        expect(immutableRead.paymentAccountSnapshotEnvelope).toBe(
            protectedRead.paymentAccountSnapshotEnvelope
        );
        expect(immutableRead.paymentAccountSnapshotVersion).toBe(1);
        await SellerWithdrawalRequest.updateOne(
            { _id: protectedRead._id },
            { $set: { paymentAccountSnapshot: { bankName: 'Whole-object Tamper' } } }
        );
        expect((await SellerWithdrawalRequest.findById(protectedRead._id).lean())
            .paymentAccountSnapshot.bankName).toBe('Account A Bank');

        await SellerWithdrawalRequest.updateOne(
            { _id: protectedRead._id },
            {
                $set: {
                    seller: new mongoose.Types.ObjectId(),
                    idempotencyKey: 'tampered-attempt',
                    amount: 999,
                    currency: 'PKR',
                    requestedAmount: 999,
                    requestedCurrency: 'GBP',
                    payoutAmount: 279720,
                    payoutCurrency: 'PKR',
                    exchangeRateSnapshot: {
                        base: 'USD',
                        rates: { USD: 1, PKR: 999, EUR: 9, GBP: 8 },
                        capturedAt: new Date('2030-01-01T00:00:00.000Z'),
                        source: 'tampered',
                        fallback: false,
                    },
                },
            }
        );
        const financialImmutableRead = await SellerWithdrawalRequest.findById(protectedRead._id).lean();
        expect(financialImmutableRead).toMatchObject({
            seller: seller._id,
            idempotencyKey: 'destination-snapshot-request',
            amount: protectedRead.amount,
            currency: 'USD',
            requestedAmount: protectedRead.requestedAmount,
            requestedCurrency: protectedRead.requestedCurrency,
            payoutAmount: protectedRead.payoutAmount,
            payoutCurrency: protectedRead.payoutCurrency,
        });
        expect(financialImmutableRead.exchangeRateSnapshot.source).toBe('snapshot-test');

        const accountUpdateResponse = responseRecorder();
        await upsertSellerPaymentAccount(sellerRequest(seller, {
            accountHolderName: 'Account B Holder',
            bankName: 'Account B Bank',
            accountNumber: accountBNumber,
            iban: accountBIBAN,
            swiftCode: 'BBBBPKKA',
            country: 'Pakistan',
            currency: 'PKR',
            payoutInstructions: 'Account B branch 999',
        }), accountUpdateResponse.res);
        expect(accountUpdateResponse.statusCode).toBe(200);

        const sellerListResponse = responseRecorder();
        await getSellerWithdrawals(sellerRequest(seller), sellerListResponse.res);
        expect(sellerListResponse.statusCode).toBe(200);
        expect(sellerListResponse.body.withdrawals[0].paymentAccountSnapshot).toMatchObject({
            bankName: 'Account A Bank',
            accountNumberLast4: '1234',
            snapshotStatus: 'complete',
        });
        const sellerListPayload = JSON.stringify(sellerListResponse.body);
        for (const sensitiveValue of [accountANumber, accountAIBAN, accountBNumber, accountBIBAN]) {
            expect(sellerListPayload).not.toContain(sensitiveValue);
        }

        const overview = await buildAdminPaymentsOverviewData();
        const adminWithdrawal = overview.withdrawals.find(
            request => request._id.toString() === protectedRead._id.toString()
        );
        expect(adminWithdrawal.paymentAccountSnapshot).toMatchObject({
            accountHolderName: 'Account A Holder',
            bankName: 'Account A Bank',
            accountNumber: accountANumber,
            iban: accountAIBAN,
            swiftCode: 'AAAAPKKA',
            currency: 'PKR',
            payoutInstructions: 'Account A branch 001',
            snapshotStatus: 'complete',
            payoutBlocked: false,
        });
        expect(adminWithdrawal).not.toHaveProperty('paymentAccountSnapshotEnvelope');
        const sellerRow = overview.sellers.find(row => row.seller._id.toString() === seller._id.toString());
        expect(sellerRow.paymentAccount).toMatchObject({
            bankName: 'Account B Bank',
            accountNumber: accountBNumber,
            iban: accountBIBAN,
        });

        const approveResponse = responseRecorder();
        await updateWithdrawalRequestStatus({
            user: { id: admin._id.toString(), role: 'admin' },
            params: { id: protectedRead._id.toString() },
            body: {
                status: 'approved',
                expectedStatus: 'pending',
                adminNote: 'Verified frozen Account A',
            },
            get: () => 'approve-frozen-account-a',
        }, approveResponse.res);
        expect(approveResponse.statusCode).toBe(200);
        expect(approveResponse.body.withdrawal.paymentAccountSnapshot).toMatchObject({
            accountNumber: accountANumber,
            iban: accountAIBAN,
            snapshotStatus: 'complete',
        });
    });

    test('authenticates the exact financial authorization and blocks raw database tampering', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'authorization-admin',
            email: 'authorization-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        await seedPayoutAccount(seller);

        const createResponse = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'authorization-bound-request' }), createResponse.res);
        expect(createResponse.statusCode).toBe(201);

        const withdrawalId = createResponse.body.withdrawal._id;
        // Bypass Mongoose deliberately. Normal updates are blocked by immutable
        // schema paths; the authenticated AAD must still catch a direct write.
        await SellerWithdrawalRequest.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(withdrawalId) },
            {
                $set: {
                    amount: 999,
                    payoutAmount: 279720,
                    payoutCurrency: 'PKR',
                    'exchangeRateSnapshot.rates.PKR': 999,
                },
            }
        );

        const approveResponse = responseRecorder();
        await updateWithdrawalRequestStatus({
            user: { id: admin._id.toString(), role: 'admin' },
            params: { id: withdrawalId.toString() },
            body: { status: 'approved', expectedStatus: 'pending' },
            get: () => 'approve-tampered-request',
        }, approveResponse.res);

        expect(approveResponse.statusCode).toBe(409);
        expect(approveResponse.body.code).toBe('WITHDRAWAL_PAYOUT_DESTINATION_UNREADABLE');
        expect((await SellerWithdrawalRequest.findById(withdrawalId)).status).toBe('pending');
    });

    test('rejects a corrupt saved account with no raw currency instead of relabelling it USD', async () => {
        const seller = await seedSellerRevenue();
        const account = await seedPayoutAccount(seller);
        await SellerPaymentAccount.collection.updateOne(
            { _id: account._id },
            { $unset: { currency: '' } }
        );

        const createResponse = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'missing-account-currency' }), createResponse.res);

        expect(createResponse.statusCode).toBe(400);
        expect(createResponse.body.code).toBe('PAYOUT_ACCOUNT_CURRENCY_UNSUPPORTED');
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });

    test('refuses to freeze a positive USD reservation to a zero-cent bank payout', async () => {
        getExchangeRateSnapshot.mockResolvedValue({
            ...trustedRates,
            rates: { USD: 1, PKR: 280, EUR: 0.0001, GBP: 0.8 },
            capturedAt: new Date().toISOString(),
        });
        const seller = await seedSellerRevenue();
        await seedPayoutAccount(seller, { currency: 'EUR' });

        const createResponse = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 5,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'zero-cent-payout-quote' }), createResponse.res);

        expect(createResponse.statusCode).toBe(503);
        expect(createResponse.body.code).toBe('WITHDRAWAL_PAYOUT_QUOTE_INVALID');
        expect(await SellerWithdrawalRequest.countDocuments({ seller: seller._id })).toBe(0);
    });

    test('returns an exact committed retry even if the current payout account was deleted', async () => {
        const seller = await seedSellerRevenue();
        await seedPayoutAccount(seller);
        const requestBody = { requestedAmount: 10, requestedCurrency: 'USD' };
        const extras = { idempotencyKey: 'retry-after-account-deletion' };

        const firstResponse = responseRecorder();
        await createWithdrawalRequest(
            sellerRequest(seller, requestBody, extras),
            firstResponse.res
        );
        expect(firstResponse.statusCode).toBe(201);
        await SellerPaymentAccount.deleteOne({ seller: seller._id });

        const retryResponse = responseRecorder();
        await createWithdrawalRequest(
            sellerRequest(seller, requestBody, extras),
            retryResponse.res
        );
        expect(retryResponse.statusCode).toBe(200);
        expect(retryResponse.body).toMatchObject({ success: true, reused: true });
        expect(retryResponse.body.withdrawal._id.toString()).toBe(
            firstResponse.body.withdrawal._id.toString()
        );
    });

    test('decrypts a preserved withdrawal before attaching a deleted-seller display profile', async () => {
        const seller = await seedSellerRevenue();
        await seedPayoutAccount(seller);
        const createResponse = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'orphaned-seller-withdrawal' }), createResponse.res);
        expect(createResponse.statusCode).toBe(201);

        await User.deleteOne({ _id: seller._id });
        const overview = await buildAdminPaymentsOverviewData();
        const withdrawal = overview.withdrawals.find(
            candidate => candidate._id.toString() === createResponse.body.withdrawal._id.toString()
        );

        expect(withdrawal.seller).toMatchObject({
            _id: seller._id,
            username: 'Deleted seller',
            deleted: true,
        });
        expect(withdrawal.paymentAccountSnapshot).toMatchObject({
            accountNumber: '001122334455',
            iban: 'PK02FROZ0000000044550000',
            snapshotStatus: 'complete',
            payoutBlocked: false,
        });
        expect(withdrawal).not.toHaveProperty('paymentAccountSnapshotEnvelope');
    });

    test('flags legacy requests and refuses to advance them using the current account', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'legacy-admin',
            email: 'legacy-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        await SellerPaymentAccount.create({
            seller: seller._id,
            accountHolderName: 'Current Holder',
            bankName: 'Current Bank',
            accountNumber: '777777771234',
            accountNumberLast4: '1234',
            currency: 'USD',
            isActive: true,
        });
        const legacy = await SellerWithdrawalRequest.create({
            seller: seller._id,
            amount: 5,
            requestedAmount: 5,
            requestedCurrency: 'USD',
            payoutAmount: 5,
            payoutCurrency: 'USD',
            status: 'pending',
            paymentAccountSnapshot: {
                bankName: 'Legacy Bank',
                accountNumberLast4: '1234',
                currency: 'USD',
            },
        });

        const overview = await buildAdminPaymentsOverviewData();
        const adminWithdrawal = overview.withdrawals.find(
            request => request._id.toString() === legacy._id.toString()
        );
        expect(adminWithdrawal.paymentAccountSnapshot).toMatchObject({
            bankName: 'Legacy Bank',
            accountNumberLast4: '1234',
            snapshotStatus: 'missing',
            payoutBlocked: true,
        });
        expect(adminWithdrawal.paymentAccountSnapshot.accountNumber).toBeUndefined();

        const approveResponse = responseRecorder();
        await updateWithdrawalRequestStatus({
            user: { id: admin._id.toString(), role: 'admin' },
            params: { id: legacy._id.toString() },
            body: { status: 'approved', expectedStatus: 'pending' },
            get: () => 'approve-legacy-request',
        }, approveResponse.res);

        expect(approveResponse.statusCode).toBe(409);
        expect(approveResponse.body).toMatchObject({
            code: 'WITHDRAWAL_PAYOUT_DESTINATION_MISSING',
        });
        expect((await SellerWithdrawalRequest.findById(legacy._id)).status).toBe('pending');
    });

    test('fails closed instead of coercing corrupt stored payout version fields', async () => {
        const seller = await seedSellerRevenue();
        const withdrawal = await SellerWithdrawalRequest.create({
            seller: seller._id,
            amount: 5,
            requestedAmount: 5,
            requestedCurrency: 'USD',
            payoutAmount: 5,
            payoutCurrency: 'USD',
            status: 'pending',
        });

        await SellerWithdrawalRequest.collection.updateOne(
            { _id: withdrawal._id },
            { $set: { paymentAccountSnapshotVersion: '1' } }
        );
        await expect(buildAdminPaymentsOverviewData()).rejects.toMatchObject({
            code: 'SELLER_FINANCIAL_DATA_INVALID',
            statusCode: 409,
        });

        await SellerWithdrawalRequest.collection.updateOne(
            { _id: withdrawal._id },
            {
                $set: {
                    paymentAccountSnapshotVersion: 0,
                    payoutWorkflowVersion: null,
                },
            }
        );
        await expect(buildAdminPaymentsOverviewData()).rejects.toMatchObject({
            code: 'SELLER_FINANCIAL_DATA_INVALID',
            statusCode: 409,
        });
    });

    test('requires an auditable attempt and transfer proof before paid, with durable replay', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'proof-admin',
            email: 'proof-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        await seedPayoutAccount(seller);

        const created = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'proof-required-request' }), created.res);
        expect(created.statusCode).toBe(201);
        const withdrawalId = created.body.withdrawal._id;

        const approved = await adminTransition(admin, withdrawalId, {
            status: 'approved',
            expectedStatus: 'pending',
        }, 'proof-approve-operation');
        expect(approved.statusCode).toBe(200);

        const missingProvider = await adminTransition(admin, withdrawalId, {
            status: 'processing',
            expectedStatus: 'approved',
        }, 'proof-process-missing-provider');
        expect(missingProvider.statusCode).toBe(400);
        expect((await SellerWithdrawalRequest.findById(withdrawalId)).status).toBe('approved');

        const processingKey = 'proof-process-operation';
        const processing = await adminTransition(admin, withdrawalId, {
            status: 'processing',
            expectedStatus: 'approved',
            payoutProvider: 'Test Bank Rail',
        }, processingKey);
        expect(processing.statusCode).toBe(200);
        expect(processing.body.withdrawal).toMatchObject({
            status: 'processing',
            activePayoutAttemptId: processingKey,
        });

        const noProof = await adminTransition(admin, withdrawalId, {
            status: 'paid',
            expectedStatus: 'processing',
            attemptId: processingKey,
        }, 'proof-paid-without-evidence');
        expect(noProof.statusCode).toBe(400);
        expect((await SellerWithdrawalRequest.findById(withdrawalId)).status).toBe('processing');

        const paidBody = {
            status: 'paid',
            expectedStatus: 'processing',
            attemptId: processingKey,
            transferReference: 'TEST-TRANSFER-0001',
            transferredAt: new Date().toISOString(),
            evidenceType: 'provider_reference',
        };
        const paidKey = 'proof-paid-operation';
        const paid = await adminTransition(admin, withdrawalId, paidBody, paidKey);
        expect(paid.statusCode).toBe(200);
        expect(paid.body.withdrawal).toMatchObject({
            status: 'paid',
            paidPayoutAttemptId: processingKey,
            paidPayoutProvider: 'Test Bank Rail',
            paidTransferReference: 'TEST-TRANSFER-0001',
        });
        expect(paid.body.withdrawal.payoutAttempts).toEqual([
            expect.objectContaining({
                attemptId: processingKey,
                status: 'paid',
                transferReference: 'TEST-TRANSFER-0001',
                evidence: expect.objectContaining({ type: 'provider_reference' }),
            }),
        ]);
        const withdrawalEvents = await NotificationOutbox.find({
            aggregateId: withdrawalId.toString(),
        }).lean();
        expect(withdrawalEvents.filter(event => event.eventType === 'withdrawal.requested'))
            .toHaveLength(7);
        expect(withdrawalEvents.filter(event => event.eventType === 'withdrawal.status_changed'))
            .toHaveLength(12);
        expect(withdrawalEvents.find(event => (
            event.eventType === 'withdrawal.status_changed'
            && event.channel === 'inapp'
            && event.payload.title === 'Withdrawal Paid'
        ))?.money).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'requested_amount', amountMinor: 1000, currency: 'USD' }),
            expect.objectContaining({ key: 'payout_amount', amountMinor: 280000, currency: 'PKR' }),
        ]));

        const replay = await adminTransition(admin, withdrawalId, paidBody, paidKey);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.reused).toBe(true);
        const persisted = await SellerWithdrawalRequest.findById(withdrawalId)
            .select('+adminOperations')
            .lean();
        expect(persisted.payoutAttempts).toHaveLength(1);
        expect(persisted.adminOperations.filter(op => op.operationKey === paidKey)).toHaveLength(1);

        const sellerList = responseRecorder();
        await getSellerWithdrawals(sellerRequest(seller), sellerList.res);
        expect(sellerList.body.withdrawals[0]).not.toHaveProperty('payoutAttempts');
        expect(sellerList.body.withdrawals[0].payoutWorkflow).toMatchObject({
            state: 'paid',
            paidTransferReference: 'TEST-TRANSFER-0001',
        });
    });

    test('retains ambiguous outcomes, releases only definitive failures, and retries with a new attempt', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'recovery-admin',
            email: 'recovery-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        await seedPayoutAccount(seller);
        const created = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 10,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'recovery-request' }), created.res);
        const withdrawalId = created.body.withdrawal._id;

        await adminTransition(admin, withdrawalId, {
            status: 'approved', expectedStatus: 'pending',
        }, 'recovery-approve-first');
        const firstAttemptId = 'recovery-process-first';
        await adminTransition(admin, withdrawalId, {
            status: 'processing',
            expectedStatus: 'approved',
            payoutProvider: 'Manual Bank Rail',
        }, firstAttemptId);
        const review = await adminTransition(admin, withdrawalId, {
            status: 'manual_review',
            expectedStatus: 'processing',
            attemptId: firstAttemptId,
            reconciliationNote: 'Provider timed out after submission; outcome is unknown.',
        }, 'recovery-manual-review');
        expect(review.statusCode).toBe(200);
        expect(review.body.withdrawal.status).toBe('manual_review');

        let summary = await require('../../controllers/PaymentController')
            .buildSellerPaymentSummary(seller._id);
        expect(summary.revenue.totalReservedOrWithdrawn).toBe(10);
        expect(summary.revenue.withdrawableBalance).toBe(40);

        const unsafeFailure = await adminTransition(admin, withdrawalId, {
            status: 'failed',
            expectedStatus: 'manual_review',
            attemptId: firstAttemptId,
            failureReason: 'No result was returned.',
        }, 'recovery-unsafe-failure');
        expect(unsafeFailure.statusCode).toBe(409);
        expect(unsafeFailure.body.code).toBe('WITHDRAWAL_FAILURE_NOT_DEFINITIVE');
        expect((await SellerWithdrawalRequest.findById(withdrawalId)).status).toBe('manual_review');

        const failed = await adminTransition(admin, withdrawalId, {
            status: 'failed',
            expectedStatus: 'manual_review',
            attemptId: firstAttemptId,
            failureCertainty: 'definitively_not_sent',
            failureCode: 'BANK_CONFIRMED_VOID',
            failureReason: 'Bank operations confirmed the transfer was never submitted.',
        }, 'recovery-definitive-failure');
        expect(failed.statusCode).toBe(200);
        expect(failed.body.withdrawal.status).toBe('failed');
        summary = await require('../../controllers/PaymentController')
            .buildSellerPaymentSummary(seller._id);
        expect(summary.revenue.totalReservedOrWithdrawn).toBe(0);
        expect(summary.revenue.withdrawableBalance).toBe(50);

        const competing = responseRecorder();
        await createWithdrawalRequest(sellerRequest(seller, {
            requestedAmount: 45,
            requestedCurrency: 'USD',
        }, { idempotencyKey: 'recovery-competing-request' }), competing.res);
        expect(competing.statusCode).toBe(201);
        const blockedRetry = await adminTransition(admin, withdrawalId, {
            status: 'approved', expectedStatus: 'failed',
        }, 'recovery-retry-insufficient');
        expect(blockedRetry.statusCode).toBe(409);
        expect(blockedRetry.body.code).toBe('WITHDRAWAL_RETRY_BALANCE_UNAVAILABLE');
        expect((await SellerWithdrawalRequest.findById(withdrawalId)).status).toBe('failed');
        const cancelCompeting = await adminTransition(admin, competing.body.withdrawal._id, {
            status: 'cancelled', expectedStatus: 'pending',
        }, 'recovery-cancel-competing');
        expect(cancelCompeting.statusCode).toBe(200);

        const retryApproval = await adminTransition(admin, withdrawalId, {
            status: 'approved', expectedStatus: 'failed',
        }, 'recovery-retry-approve');
        expect(retryApproval.statusCode).toBe(200);
        const secondAttemptId = 'recovery-process-second';
        const retryProcessing = await adminTransition(admin, withdrawalId, {
            status: 'processing',
            expectedStatus: 'approved',
            payoutProvider: 'Manual Bank Rail',
        }, secondAttemptId);
        expect(retryProcessing.statusCode).toBe(200);
        expect(retryProcessing.body.withdrawal.payoutAttempts).toEqual([
            expect.objectContaining({ attemptId: firstAttemptId, status: 'failed' }),
            expect.objectContaining({ attemptId: secondAttemptId, status: 'processing' }),
        ]);
        const approvedEvents = await NotificationOutbox.find({
            aggregateId: withdrawalId.toString(),
            eventType: 'withdrawal.status_changed',
            channel: 'inapp',
            'payload.title': 'Withdrawal Approved',
        }).lean();
        expect(approvedEvents).toHaveLength(2);
        expect(new Set(approvedEvents.map(event => event.eventKey)).size).toBe(2);
        summary = await require('../../controllers/PaymentController')
            .buildSellerPaymentSummary(seller._id);
        expect(summary.revenue.totalReservedOrWithdrawn).toBe(10);
    });

    test('quarantines legacy processing rows before proof-based resolution', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'legacy-recovery-admin',
            email: 'legacy-recovery-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        const legacy = await SellerWithdrawalRequest.create({
            seller: seller._id,
            amount: 5,
            requestedAmount: 5,
            requestedCurrency: 'USD',
            payoutAmount: 5,
            payoutCurrency: 'USD',
            status: 'processing',
            payoutWorkflowVersion: 0,
        });

        const directPaid = await adminTransition(admin, legacy._id, {
            status: 'paid',
            expectedStatus: 'processing',
            transferReference: 'LEGACY-TRANSFER-1',
            transferredAt: new Date().toISOString(),
            evidenceType: 'provider_reference',
        }, 'legacy-direct-paid-operation');
        expect(directPaid.statusCode).toBe(409);
        expect(directPaid.body.code).toBe('WITHDRAWAL_LEGACY_PROCESSING_QUARANTINED');

        const importedAttemptId = 'legacy-quarantine-operation';
        const quarantined = await adminTransition(admin, legacy._id, {
            status: 'manual_review',
            expectedStatus: 'processing',
            payoutProvider: 'Historical Bank Export',
            reconciliationNote: 'Imported processing row has no recorded transfer outcome.',
        }, importedAttemptId);
        expect(quarantined.statusCode).toBe(200);
        expect(quarantined.body.withdrawal).toMatchObject({
            status: 'manual_review',
            activePayoutAttemptId: importedAttemptId,
        });
        expect(quarantined.body.withdrawal.payoutAttempts[0]).toMatchObject({
            legacyImported: true,
            status: 'manual_review',
        });

        const resolved = await adminTransition(admin, legacy._id, {
            status: 'paid',
            expectedStatus: 'manual_review',
            attemptId: importedAttemptId,
            transferReference: 'LEGACY-TRANSFER-1',
            transferredAt: new Date().toISOString(),
            evidenceType: 'bank_statement',
            evidenceNote: 'Historical bank statement confirms the exact transfer.',
        }, 'legacy-proof-resolution');
        expect(resolved.statusCode).toBe(200);
        expect(resolved.body.withdrawal).toMatchObject({
            status: 'paid',
            paidTransferReference: 'LEGACY-TRANSFER-1',
        });
    });

    test('does not allow one provider transfer reference to prove two withdrawals', async () => {
        const seller = await seedSellerRevenue();
        const admin = await User.create({
            username: 'reference-admin',
            email: 'reference-admin@test.com',
            password: 'password123',
            role: 'admin',
        });
        await seedPayoutAccount(seller);
        const ids = [];
        for (const suffix of ['a', 'b']) {
            const created = responseRecorder();
            await createWithdrawalRequest(sellerRequest(seller, {
                requestedAmount: 10,
                requestedCurrency: 'USD',
            }, { idempotencyKey: `duplicate-reference-${suffix}` }), created.res);
            ids.push(created.body.withdrawal._id);
            await adminTransition(admin, ids.at(-1), {
                status: 'approved', expectedStatus: 'pending',
            }, `duplicate-reference-approve-${suffix}`);
            await adminTransition(admin, ids.at(-1), {
                status: 'processing',
                expectedStatus: 'approved',
                payoutProvider: suffix === 'a' ? 'Shared Provider' : 'shared provider',
            }, `duplicate-reference-process-${suffix}`);
        }

        const proof = suffix => ({
            status: 'paid',
            expectedStatus: 'processing',
            attemptId: `duplicate-reference-process-${suffix}`,
            transferReference: suffix === 'a'
                ? 'SHARED-REFERENCE-001'
                : 'shared-reference-001',
            transferredAt: new Date().toISOString(),
            evidenceType: 'provider_reference',
        });
        const firstPaid = await adminTransition(
            admin, ids[0], proof('a'), 'duplicate-reference-paid-a'
        );
        expect(firstPaid.statusCode).toBe(200);
        const duplicate = await adminTransition(
            admin, ids[1], proof('b'), 'duplicate-reference-paid-b'
        );
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.body.code).toBe('WITHDRAWAL_TRANSFER_REFERENCE_ALREADY_USED');
        expect((await SellerWithdrawalRequest.findById(ids[1])).status).toBe('processing');
    });
});
