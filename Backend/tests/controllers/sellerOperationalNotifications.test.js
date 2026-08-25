'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../controllers/subscriptionController', () => ({
  initializeSubscription: jest.fn(async () => null),
}));

const sellerOperationalNotifications = require('../../services/sellerOperationalNotificationService');
const enqueueStoreVerificationSpy = jest.spyOn(
  sellerOperationalNotifications,
  'enqueueStoreVerificationNotification'
);
const enqueuePayoutAccountSpy = jest.spyOn(
  sellerOperationalNotifications,
  'enqueuePayoutAccountUpdatedNotification'
);

const {
  approveVerification,
  createStore,
  rejectVerification,
  removeVerification,
} = require('../../controllers/storeController');
const { upsertSellerPaymentAccount } = require('../../controllers/PaymentController');
const { buildModerationFields } = require('../../services/productModerationService');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Product = require('../../models/Product');
const SellerPaymentAccount = require('../../models/SellerPaymentAccount');
const Store = require('../../models/Store');
const User = require('../../models/User');

let replicaSet;

const responseRecorder = () => {
  const response = { statusCode: 200, body: null };
  response.res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  return response;
};

const createUser = (role, suffix, extra = {}) => User.create({
  username: `${role}-${suffix}`,
  email: `${role}-${suffix}@example.com`,
  password: 'password123',
  role,
  status: 'active',
  ...extra,
});

const sellerRequest = (seller, body) => ({
  user: {
    id: seller._id.toString(),
    role: 'seller',
    currency: seller.currency || 'USD',
  },
  body,
  query: {},
  params: {},
  get: () => '',
});

const adminRequest = (admin, store, body = {}) => ({
  user: { id: admin._id.toString(), role: 'admin', status: 'active' },
  params: { storeId: store._id.toString() },
  body,
});

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 60000);

beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([
    NotificationOutbox.deleteMany({}),
    Product.deleteMany({}),
    SellerPaymentAccount.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
  ]);
});

describe('durable seller operational notifications', () => {
  test('stages product notices only on a new blocked transition', () => {
    const placeholder = {
      name: 'Test Product',
      description: 'dummy',
      price: 10,
      category: 'Testing',
      brand: 'Testing',
    };
    const newlyBlocked = buildModerationFields(placeholder, { previouslyBlocked: false });
    const stillBlocked = buildModerationFields(placeholder, { previouslyBlocked: true });
    const corrected = buildModerationFields({
      ...placeholder,
      name: 'Handcrafted walnut serving tray',
      description: 'A handcrafted solid walnut serving tray finished with food-safe oil.',
    }, { previouslyBlocked: true });

    expect(newlyBlocked.fields.moderationNotice).toMatchObject({
      productName: 'Test Product',
      notificationEnqueuedAt: null,
    });
    expect(stillBlocked.fields).not.toHaveProperty('moderationNotice');
    expect(corrected.fields.moderationNotice).toMatchObject({
      reviewedAt: null,
      productName: '',
      reason: '',
    });
    expect(corrected.fields.moderationNotice.notificationEnqueuedAt).toBeInstanceOf(Date);
  });

  test('store creation and every verification outcome target the seller on all four channels', async () => {
    const seller = await createUser('seller', 'store-events', { currency: 'PKR' });
    const admin = await createUser('admin', 'store-events');
    const createResponse = responseRecorder();

    await createStore(sellerRequest(seller, {
      storeName: 'Durable Seller Store',
      description: 'A production store for durable event testing.',
    }), createResponse.res);

    expect(createResponse.statusCode).toBe(201);
    let store = await Store.findOne({ seller: seller._id });
    expect(store).toBeTruthy();
    expect(store.productCurrency).toBe('PKR');
    expect(await NotificationOutbox.countDocuments({ eventType: 'store.created' })).toBe(4);

    const approveResponse = responseRecorder();
    await approveVerification(adminRequest(admin, store), approveResponse.res);
    expect(approveResponse.statusCode).toBe(200);
    expect(await NotificationOutbox.countDocuments({ eventType: 'store.verification_approved' })).toBe(4);

    store = await Store.findById(store._id);
    const removeResponse = responseRecorder();
    await removeVerification(adminRequest(admin, store, { reason: 'Scheduled badge review' }), removeResponse.res);
    expect(removeResponse.statusCode).toBe(200);
    expect(await NotificationOutbox.countDocuments({ eventType: 'store.verification_removed' })).toBe(4);

    await Store.updateOne({ _id: store._id }, {
      $set: {
        'verification.status': 'pending',
        'verification.isVerified': false,
      },
    });
    store = await Store.findById(store._id);
    const rejectResponse = responseRecorder();
    await rejectVerification(
      adminRequest(admin, store, { rejectionReason: '<script>Improve the legal profile</script>' }),
      rejectResponse.res
    );
    expect(rejectResponse.statusCode).toBe(200);

    const rejected = await NotificationOutbox.find({ eventType: 'store.verification_rejected' }).lean();
    expect(rejected).toHaveLength(4);
    expect(rejected.every(row => String(row.recipient.user) === seller._id.toString())).toBe(true);
    expect(rejected.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    const email = rejected.find(row => row.channel === 'email');
    expect(email.payload.html).toContain('&lt;script&gt;Improve the legal profile&lt;/script&gt;');
    expect(email.payload.html).not.toContain('<script>');
    const push = rejected.find(row => row.channel === 'push');
    expect(push.payload).toMatchObject({
      linkTo: '/seller-dashboard/store-settings',
      channelId: 'seller',
      data: expect.objectContaining({
        type: 'store_verification_rejected',
        audienceRole: 'seller',
      }),
    });
  });

  test('a verification outbox failure rolls the source transition back', async () => {
    const seller = await createUser('seller', 'verification-rollback');
    const admin = await createUser('admin', 'verification-rollback');
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Verification Rollback Store',
      storeSlug: 'verification-rollback-store',
      verification: { status: 'pending', isVerified: false, appliedAt: new Date() },
    });
    enqueueStoreVerificationSpy.mockRejectedValueOnce(new Error('simulated outbox insert failure'));
    const response = responseRecorder();

    await approveVerification(adminRequest(admin, store), response.res);

    expect(response.statusCode).toBe(500);
    const unchanged = await Store.findById(store._id).lean();
    expect(unchanged.verification).toMatchObject({ status: 'pending', isVerified: false });
    expect(await NotificationOutbox.countDocuments({ aggregateId: store._id.toString() })).toBe(0);
  });

  test('payout-account security confirmations are redacted, deduplicated for no-op retries, and transactional', async () => {
    const seller = await createUser('seller', 'payout-events', { currency: 'PKR' });
    const body = {
      accountHolderName: 'Durable Seller',
      bankName: 'Production Bank',
      accountNumber: '0011223344556677',
      iban: 'PK36SCBL0000001123456702',
      swiftCode: 'PRODPKKA',
      country: 'Pakistan',
      currency: 'PKR',
      payoutInstructions: 'Primary payout destination',
    };

    const first = responseRecorder();
    await upsertSellerPaymentAccount(sellerRequest(seller, body), first.res);
    expect(first.statusCode).toBe(200);
    expect(first.body.paymentAccount).not.toHaveProperty('accountNumber');
    expect(first.body.paymentAccount).not.toHaveProperty('iban');

    const firstRows = await NotificationOutbox.find({ eventType: 'payout.account_updated' }).lean();
    expect(firstRows).toHaveLength(4);
    expect(firstRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    const serialized = JSON.stringify(firstRows);
    expect(serialized).not.toContain(body.accountNumber);
    expect(serialized).not.toContain(body.iban);
    expect(serialized).toContain('6702');
    expect(serialized).toContain('PKR');

    const replay = responseRecorder();
    await upsertSellerPaymentAccount(sellerRequest(seller, body), replay.res);
    expect(replay.statusCode).toBe(200);
    expect(await NotificationOutbox.countDocuments({ eventType: 'payout.account_updated' })).toBe(4);

    for (const invalidBody of [
      { ...body, accountNumber: '-', iban: '' },
      { ...body, iban: 'PK00SCBL0000001123456702' },
      { ...body, swiftCode: 'PRODUS33' },
      { ...body, country: 'Not a real country' },
    ]) {
      const invalid = responseRecorder();
      await upsertSellerPaymentAccount(sellerRequest(seller, invalidBody), invalid.res);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.body).toMatchObject({ code: 'PAYOUT_ACCOUNT_INPUT_INVALID' });
    }
    expect(await NotificationOutbox.countDocuments({ eventType: 'payout.account_updated' })).toBe(4);

    const partialRequest = sellerRequest(seller, {
      accountHolderName: body.accountHolderName,
      bankName: body.bankName,
    });
    partialRequest.user.currency = 'USD';
    const partialReplay = responseRecorder();
    await upsertSellerPaymentAccount(partialRequest, partialReplay.res);
    expect(partialReplay.statusCode).toBe(200);
    const preserved = await SellerPaymentAccount.findOne({ seller: seller._id })
      .select('+accountNumber +iban')
      .lean();
    expect(preserved).toMatchObject({
      currency: 'PKR',
      swiftCode: body.swiftCode,
      country: body.country,
      payoutInstructions: body.payoutInstructions,
      accountNumber: body.accountNumber,
      iban: body.iban,
    });
    expect(await NotificationOutbox.countDocuments({ eventType: 'payout.account_updated' })).toBe(4);

    const invalidNumber = responseRecorder();
    await upsertSellerPaymentAccount(sellerRequest(seller, {
      ...body,
      accountNumber: 1122334455,
    }), invalidNumber.res);
    expect(invalidNumber.statusCode).toBe(400);
    expect(invalidNumber.body).toMatchObject({ code: 'PAYOUT_ACCOUNT_INPUT_INVALID' });
    expect(await NotificationOutbox.countDocuments({ eventType: 'payout.account_updated' })).toBe(4);

    enqueuePayoutAccountSpy.mockRejectedValueOnce(new Error('simulated payout outbox failure'));
    const failedChange = responseRecorder();
    await upsertSellerPaymentAccount(sellerRequest(seller, {
      ...body,
      bankName: 'Uncommitted Bank',
      accountNumber: '9988776655443322',
    }), failedChange.res);
    expect(failedChange.statusCode).toBe(500);
    const unchanged = await SellerPaymentAccount.findOne({ seller: seller._id })
      .select('+accountNumber')
      .lean();
    expect(unchanged.bankName).toBe('Production Bank');
    expect(unchanged.accountNumber).toBe(body.accountNumber);
    expect(await NotificationOutbox.countDocuments({ eventType: 'payout.account_updated' })).toBe(4);
  });

  test('payout-account notifications fail closed for corrupt stored currency or masking metadata', async () => {
    const account = {
      _id: new mongoose.Types.ObjectId(),
      seller: new mongoose.Types.ObjectId(),
      bankName: 'Production Bank',
      currency: 'PKR',
      ibanLast4: '6702',
    };
    const notification = overrides => sellerOperationalNotifications
      .enqueuePayoutAccountUpdatedNotification({
        account: { ...account, ...overrides },
        occurredAt: new Date(),
        changeFingerprint: 'corrupt-source-guard',
      });

    await expect(notification({ currency: 'CAD' })).rejects.toThrow(/currency is invalid/i);
    await expect(notification({ ibanLast4: '12345' })).rejects.toThrow(/last four/i);
    await expect(notification({ ibanLast4: true })).rejects.toThrow(/last four/i);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: account._id.toString(),
    })).toBe(0);
  });

  test('welcome and product-blocked recovery markers replay safely without duplicate channels', async () => {
    const welcomeAt = new Date('2026-08-24T08:00:00.000Z');
    const seller = await createUser('seller', 'marker-recovery', {
      sellerWelcomeNotice: {
        occurredAt: welcomeAt,
        storeName: 'Recovery Store',
        notificationEnqueuedAt: null,
      },
    });
    const { fields } = buildModerationFields({
      name: 'Test Product',
      description: 'dummy',
      price: 10,
      category: 'Testing',
      brand: 'Testing',
    });
    const product = await Product.create({
      seller: seller._id,
      name: 'Test Product',
      description: 'dummy',
      price: 10,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Testing',
      brand: 'Testing',
      stock: 1,
      image: 'https://example.com/test.jpg',
      images: [{ url: 'https://example.com/test.jpg' }],
      ...fields,
    });

    const firstBatch = await sellerOperationalNotifications
      .recoverPendingSellerOperationalNotifications({ limit: 1 });
    expect(firstBatch).toHaveLength(1);
    expect(await NotificationOutbox.countDocuments({ eventType: 'seller.account_created' })).toBe(4);
    expect(await NotificationOutbox.countDocuments({ eventType: 'product.blocked' })).toBe(0);

    const secondBatch = await sellerOperationalNotifications
      .recoverPendingSellerOperationalNotifications({ limit: 1 });
    expect(secondBatch).toHaveLength(1);
    expect(await NotificationOutbox.countDocuments({ eventType: 'seller.account_created' })).toBe(4);
    expect(await NotificationOutbox.countDocuments({ eventType: 'product.blocked' })).toBe(4);
    let refreshedUser = await User.findById(seller._id).lean();
    let refreshedProduct = await Product.findById(product._id).lean();
    expect(refreshedUser.sellerWelcomeNotice.notificationEnqueuedAt).toBeTruthy();
    expect(refreshedProduct.moderationNotice.notificationEnqueuedAt).toBeTruthy();

    await User.updateOne({ _id: seller._id }, {
      $set: { 'sellerWelcomeNotice.notificationEnqueuedAt': null },
    });
    await Product.updateOne({ _id: product._id }, {
      $set: { 'moderationNotice.notificationEnqueuedAt': null },
    });
    await sellerOperationalNotifications.recoverPendingSellerOperationalNotifications({ limit: 10 });

    expect(await NotificationOutbox.countDocuments({ eventType: 'seller.account_created' })).toBe(4);
    expect(await NotificationOutbox.countDocuments({ eventType: 'product.blocked' })).toBe(4);
    refreshedUser = await User.findById(seller._id).lean();
    refreshedProduct = await Product.findById(product._id).lean();
    expect(refreshedUser.sellerWelcomeNotice.notificationEnqueuedAt).toBeTruthy();
    expect(refreshedProduct.moderationNotice.notificationEnqueuedAt).toBeTruthy();
  });

  test('recovers a blocked-product notice when the legacy block flags disagree', async () => {
    const seller = await createUser('seller', 'legacy-block-state');
    const reviewedAt = new Date('2026-08-24T09:00:00.000Z');
    const product = await Product.create({
      seller: seller._id,
      name: 'Legacy blocked product',
      description: 'A product with a legacy moderation flag mismatch.',
      price: 10,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Testing',
      brand: 'Testing',
      stock: 1,
      image: 'https://example.com/legacy-blocked.jpg',
      images: [{ url: 'https://example.com/legacy-blocked.jpg' }],
      isBlocked: false,
      moderationStatus: 'blocked',
      moderationReviewedAt: reviewedAt,
      moderationNotice: {
        reviewedAt,
        productName: 'Legacy blocked product',
        reason: 'it requires a moderation correction',
        notificationEnqueuedAt: null,
      },
    });

    const recovered = await sellerOperationalNotifications
      .recoverPendingSellerOperationalNotifications({ limit: 1 });

    expect(recovered).toEqual([expect.objectContaining({
      kind: 'product_blocked',
      id: product._id.toString(),
      recovered: true,
    })]);
    expect(await NotificationOutbox.countDocuments({ eventType: 'product.blocked' })).toBe(4);
    const refreshed = await Product.findById(product._id).lean();
    expect(refreshed.moderationNotice.notificationEnqueuedAt).toBeTruthy();
  });
});
