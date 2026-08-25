'use strict';

const mockEnqueueOrderConfirmation = jest.fn();
const mockEnqueueGenericTextNotification = jest.fn();
const mockEnqueueTextNotification = jest.fn();
const mockFindGenericTextNotificationJob = jest.fn();
const mockFindOrderConfirmationJob = jest.fn();
const mockFindTextNotificationJob = jest.fn();
const mockNotifySeller = jest.fn();
jest.mock('../../services/whatsapp/queue', () => ({
  enqueueOrderConfirmation: (...args) => mockEnqueueOrderConfirmation(...args),
  enqueueGenericTextNotification: (...args) => mockEnqueueGenericTextNotification(...args),
  enqueueTextNotification: (...args) => mockEnqueueTextNotification(...args),
  findGenericTextNotificationJob: (...args) => mockFindGenericTextNotificationJob(...args),
  findOrderConfirmationJob: (...args) => mockFindOrderConfirmationJob(...args),
  findTextNotificationJob: (...args) => mockFindTextNotificationJob(...args),
}));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
  notifySeller: (...args) => mockNotifySeller(...args),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Notification = require('../../models/Notification');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const SellerSubscription = require('../../models/SellerSubscription');
const Store = require('../../models/Store');
const StoreReview = require('../../models/StoreReview');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const StripePaymentRiskEvent = require('../../models/StripePaymentRiskEvent');
const StripePaymentRiskReview = require('../../models/StripePaymentRiskReview');
const StripeSubscriptionCleanup = require('../../models/StripeSubscriptionCleanup');
const User = require('../../models/User');
const WalletTransaction = require('../../models/WalletTransaction');
const {
  buildOrderButtonsPayload,
  buildOrderListPayload,
} = require('../../services/whatsapp/messageBuilder');
const {
  buyerWhatsAppJobOutcome,
  deliverNotificationRecord,
  targetRoleForAudience,
  verifyStripeRiskReviewNotificationAuthority,
  verifyStripeRiskNotificationAuthority,
  verifySubscriptionCleanupNotificationAuthority,
} = require('../../services/notificationOutboxDeliveryService');

let mongoServer;

const recordFor = (user, audienceRole, overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  dedupeKey: `dedupe-${new mongoose.Types.ObjectId()}`,
  eventKey: `system:role-check:${new mongoose.Types.ObjectId()}`,
  eventType: 'system.role_check',
  channel: 'inapp',
  recipient: {
    kind: 'user',
    audienceRole,
    user: user._id,
    destinationPolicy: 'current_user',
    allowBlocked: false,
  },
  payload: {
    title: 'Private update',
    body: 'This message is scoped to its original audience.',
    category: audienceRole === 'seller' ? 'seller' : 'system',
    linkTo: audienceRole === 'seller' ? '/seller-dashboard' : '/user-dashboard',
  },
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Notification.syncIndexes();
}, 60000);

afterEach(async () => {
  jest.restoreAllMocks();
  mockEnqueueOrderConfirmation.mockReset();
  mockEnqueueGenericTextNotification.mockReset();
  mockEnqueueTextNotification.mockReset();
  mockFindGenericTextNotificationJob.mockReset();
  mockFindOrderConfirmationJob.mockReset();
  mockFindTextNotificationJob.mockReset();
  mockNotifySeller.mockReset();
  mockFindOrderConfirmationJob.mockResolvedValue(null);
  mockFindGenericTextNotificationJob.mockResolvedValue(null);
  mockFindTextNotificationJob.mockResolvedValue(null);
  await Promise.all([
    Notification.deleteMany({}),
    Product.deleteMany({}),
    SellerSubscription.deleteMany({}),
    Store.deleteMany({}),
    StoreReview.deleteMany({}),
    StripeEntitlementPayment.deleteMany({}),
    StripePaymentRiskReview.deleteMany({}),
    StripeSubscriptionCleanup.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('notification outbox recipient authority', () => {
  test('delivers only an exact open Stripe risk review to its active admin and skips it after resolution', async () => {
    const admin = await User.create({
      username: 'risk-review-admin',
      email: 'risk-review-admin@example.com',
      password: 'password123',
      role: 'admin',
      status: 'active',
    });
    const occurredAt = new Date('2026-08-25T10:00:00.000Z');
    const review = await StripePaymentRiskReview.create({
      reviewKey: 'review-delivery-authority',
      stripeEventId: 'evt_review_delivery_authority',
      stripeEventType: 'charge.refunded',
      occurredAt,
      sourceType: 'wallet_top_up',
      sourceReferenceId: String(new mongoose.Types.ObjectId()),
      paymentIntentId: 'pi_review_delivery_authority',
      chargeId: 'ch_review_delivery_authority',
      reasonCode: 'STRIPE_REFUND_EVIDENCE_PAGE_INVALID',
      reason: 'Provider evidence could not be hydrated safely.',
      currency: 'USD',
      chargeAmountMinor: 1000,
      refundExposureMinor: 500,
      status: 'open',
      contentHash: 'review-delivery-content-hash',
    });
    const exact = recordFor(admin, 'admin', {
      eventKey: `stripe-risk-review:${review.reviewKey}:admin:${admin._id}:v1`,
      eventType: 'payment.risk_review_required',
      aggregateType: 'StripePaymentRiskReview',
      aggregateId: review._id,
      occurredAt,
      financial: false,
      money: [],
      payload: {
        title: 'Stripe payment risk requires manual review',
        body: 'No outcome was inferred.',
        category: 'payment',
        linkTo: '/admin-dashboard/payments',
        data: {
          reviewId: String(review._id),
          sourceType: review.sourceType,
          reasonCode: review.reasonCode,
          providerEvent: review.stripeEventId,
        },
      },
    });

    await expect(verifyStripeRiskReviewNotificationAuthority(exact)).resolves.toBeNull();
    await expect(deliverNotificationRecord(exact)).resolves.toMatchObject({ outcome: 'delivered' });

    await StripePaymentRiskReview.updateOne({ _id: review._id }, {
      $set: { status: 'resolved', resolvedAt: new Date(), resolutionNote: 'Automatic retry completed.' },
    });
    await expect(verifyStripeRiskReviewNotificationAuthority(exact)).resolves.toMatchObject({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
  });

  test('rejects a forged buyer recipient for an open Stripe risk review', async () => {
    const buyer = await User.create({
      username: 'risk-review-forged-buyer',
      email: 'risk-review-forged-buyer@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
    });
    const occurredAt = new Date('2026-08-25T10:05:00.000Z');
    const review = await StripePaymentRiskReview.create({
      reviewKey: 'review-forged-recipient',
      stripeEventId: 'evt_review_forged_recipient',
      stripeEventType: 'charge.refunded',
      occurredAt,
      sourceType: 'order_payment',
      reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_MISMATCH',
      reason: 'Ownership could not be proven.',
      contentHash: 'review-forged-content-hash',
    });
    const forged = recordFor(buyer, 'buyer', {
      eventKey: `stripe-risk-review:${review.reviewKey}:admin:${buyer._id}:v1`,
      eventType: 'payment.risk_review_required',
      aggregateType: 'StripePaymentRiskReview',
      aggregateId: review._id,
      occurredAt,
      financial: false,
      money: [],
      payload: {
        title: 'Private review',
        body: 'Must not reach buyer.',
        category: 'payment',
        linkTo: '/admin-dashboard/payments',
        data: {
          reviewId: String(review._id),
          sourceType: review.sourceType,
          reasonCode: review.reasonCode,
          providerEvent: review.stripeEventId,
        },
      },
    });
    await expect(deliverNotificationRecord(forged)).resolves.toMatchObject({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
    expect(await Notification.countDocuments({ user: buyer._id })).toBe(0);
  });

  test('delivers an exact unresolved subscription-cleanup review and skips it after recovery', async () => {
    const [admin, seller] = await Promise.all([
      User.create({
        username: 'cleanup-review-admin',
        email: 'cleanup-review-admin@example.com',
        password: 'password123',
        role: 'admin',
        status: 'active',
      }),
      User.create({
        username: 'cleanup-review-seller',
        email: 'cleanup-review-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
    ]);
    const requiredAt = new Date('2026-08-25T10:10:00.000Z');
    const cleanup = await StripeSubscriptionCleanup.create({
      cleanupKey: 'a'.repeat(64),
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_delivery_required_old',
      replacementStripeSubscriptionId: 'sub_cleanup_delivery_required_new',
      stripeCustomerId: 'cus_cleanup_delivery_required',
      reason: 'replacement_activation',
      sourceReference: 'cs_cleanup_delivery_required',
      occurredAt: new Date('2026-08-25T10:00:00.000Z'),
      status: 'manual_review',
      attempts: 1,
      firstFailureAt: requiredAt,
      lastAttemptAt: requiredAt,
      lastErrorCode: 'ECONNRESET',
      lastError: 'Cancellation could not be confirmed.',
      manualReview: {
        requiredAt,
        reasonCode: 'STRIPE_CANCELLATION_UNCONFIRMED',
        notificationEnqueuedAt: requiredAt,
      },
    });
    const exact = recordFor(admin, 'admin', {
      eventKey: `subscription-cleanup:${cleanup.cleanupKey}:required:admin:${admin._id}:v1`,
      eventType: 'subscription.cleanup_required',
      aggregateType: 'StripeSubscriptionCleanup',
      aggregateId: cleanup._id,
      occurredAt: requiredAt,
      financial: false,
      money: [],
      payload: {
        title: 'Stripe subscription cleanup requires review',
        body: 'Cancellation could not be confirmed.',
        category: 'subscription',
        linkTo: '/admin-dashboard/payments',
        data: {
          type: 'subscription_cleanup_review_required',
          cleanupId: String(cleanup._id),
          sellerId: String(seller._id),
          reason: cleanup.reason,
        },
      },
    });

    await expect(verifySubscriptionCleanupNotificationAuthority(exact)).resolves.toBeNull();
    await expect(deliverNotificationRecord(exact)).resolves.toMatchObject({ outcome: 'delivered' });

    const completedAt = new Date('2026-08-25T10:15:00.000Z');
    await StripeSubscriptionCleanup.updateOne({ _id: cleanup._id }, {
      $set: {
        status: 'completed',
        providerStatus: 'canceled',
        cancelledAt: completedAt,
        completedAt,
        'manualReview.resolvedAt': completedAt,
      },
    });
    await expect(verifySubscriptionCleanupNotificationAuthority(exact)).resolves.toMatchObject({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
  });

  test('a cleanup-resolution alert requires exact provider state, event identity, recipient, and empty money', async () => {
    const [admin, seller] = await Promise.all([
      User.create({
        username: 'cleanup-resolution-admin',
        email: 'cleanup-resolution-admin@example.com',
        password: 'password123',
        role: 'admin',
        status: 'active',
      }),
      User.create({
        username: 'cleanup-resolution-seller',
        email: 'cleanup-resolution-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
    ]);
    const requiredAt = new Date('2026-08-25T11:00:00.000Z');
    const completedAt = new Date('2026-08-25T11:05:00.000Z');
    const cleanup = await StripeSubscriptionCleanup.create({
      cleanupKey: 'b'.repeat(64),
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_delivery_resolved_old',
      replacementStripeSubscriptionId: 'sub_cleanup_delivery_resolved_new',
      stripeCustomerId: 'cus_cleanup_delivery_resolved',
      reason: 'replacement_activation',
      sourceReference: 'cs_cleanup_delivery_resolved',
      occurredAt: new Date('2026-08-25T10:50:00.000Z'),
      status: 'completed',
      attempts: 2,
      firstFailureAt: requiredAt,
      lastAttemptAt: completedAt,
      providerStatus: 'canceled',
      cancelledAt: completedAt,
      completedAt,
      manualReview: {
        requiredAt,
        reasonCode: 'STRIPE_CANCELLATION_UNCONFIRMED',
        notificationEnqueuedAt: requiredAt,
        resolvedAt: completedAt,
      },
    });
    const exact = recordFor(admin, 'admin', {
      eventKey: `subscription-cleanup:${cleanup.cleanupKey}:resolved:admin:${admin._id}:v1`,
      eventType: 'subscription.cleanup_resolved',
      aggregateType: 'StripeSubscriptionCleanup',
      aggregateId: cleanup._id,
      occurredAt: completedAt,
      financial: false,
      money: [],
      payload: {
        title: 'Stripe subscription cleanup resolved',
        body: 'Cancellation is confirmed.',
        category: 'subscription',
        linkTo: '/admin-dashboard/payments',
        data: {
          type: 'subscription_cleanup_resolved',
          cleanupId: String(cleanup._id),
          sellerId: String(seller._id),
          reason: cleanup.reason,
        },
      },
    });

    await expect(verifySubscriptionCleanupNotificationAuthority(exact)).resolves.toBeNull();
    const forgedVariants = [
      { ...exact, occurredAt: new Date(completedAt.getTime() + 1) },
      { ...exact, eventKey: `${exact.eventKey}:forged` },
      { ...exact, recipient: { ...exact.recipient, audienceRole: 'buyer' } },
      { ...exact, payload: { ...exact.payload, data: { ...exact.payload.data, sellerId: String(admin._id) } } },
      {
        ...exact,
        financial: true,
        money: [{
          key: 'forged', amountMinor: 1, currency: 'USD',
          sourceModel: 'StripeSubscriptionCleanup',
          sourceDocumentId: String(cleanup._id), sourcePath: 'attempts',
        }],
      },
    ];
    for (const forged of forgedVariants) {
      await expect(verifySubscriptionCleanupNotificationAuthority(forged)).resolves.toMatchObject({
        outcome: 'skipped',
        code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
      });
    }

    await StripeSubscriptionCleanup.updateOne({ _id: cleanup._id }, {
      $set: { providerStatus: 'active' },
    });
    await expect(verifySubscriptionCleanupNotificationAuthority(exact)).resolves.toMatchObject({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
  });

  test('buyer commerce notifications remain available to a seller buying as a customer', async () => {
    const seller = await User.create({
      username: 'seller-buyer',
      email: 'seller-buyer@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const result = await deliverNotificationRecord(recordFor(seller, 'buyer'));
    expect(result.outcome).toBe('delivered');
    const notification = await Notification.findOne({ user: seller._id }).lean();
    expect(notification).toEqual(expect.objectContaining({
      targetRole: 'both',
      audience: 'specific',
    }));
  });

  test('seller-private events fail closed after the account is demoted', async () => {
    const account = await User.create({
      username: 'former-seller',
      email: 'former-seller@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
    });
    const result = await deliverNotificationRecord(recordFor(account, 'seller'));
    expect(result).toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'RECIPIENT_ROLE_CHANGED',
    }));
    expect(await Notification.countDocuments()).toBe(0);
  });

  test('blocked accounts receive only explicit alerts and role-owned immutable financial receipts', async () => {
    const seller = await User.create({
      username: 'blocked-seller',
      email: 'blocked-seller@example.com',
      password: 'password123',
      role: 'seller',
      status: 'blocked',
    });
    const ordinary = await deliverNotificationRecord(recordFor(seller, 'seller'));
    expect(ordinary).toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'RECIPIENT_BLOCKED',
    }));

    const explicitAlert = recordFor(seller, 'seller');
    explicitAlert.eventType = 'account.blocked';
    explicitAlert.recipient.allowBlocked = true;
    explicitAlert.payload.title = 'Account blocked';
    explicitAlert.payload.body = 'Your seller account has been blocked.';
    const allowed = await deliverNotificationRecord(explicitAlert);
    expect(allowed.outcome).toBe('delivered');

    const paidReceipt = recordFor(seller, 'seller');
    paidReceipt.eventType = 'order.paid';
    paidReceipt.recipient.allowBlocked = true;
    paidReceipt.payload.title = 'Paid order receipt';
    const paidResult = await deliverNotificationRecord(paidReceipt);
    expect(paidResult.outcome).toBe('delivered');

    const forgedAudience = recordFor(seller, 'buyer');
    forgedAudience.eventType = 'subdomain.payment_received';
    forgedAudience.recipient.allowBlocked = true;
    const forgedResult = await deliverNotificationRecord(forgedAudience);
    expect(forgedResult).toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments({ user: seller._id })).toBe(2);
  });

  test('audience roles map to the in-app visibility boundary', () => {
    expect(targetRoleForAudience).toEqual({
      buyer: 'both',
      seller: 'seller',
      admin: 'admin',
    });
  });

  test('a blocked-product alert is skipped after the exact moderation state is corrected', async () => {
    const seller = await User.create({
      username: 'corrected-product-seller',
      email: 'corrected-product-seller@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const reviewedAt = new Date('2026-08-24T10:00:00.000Z');
    const product = await Product.create({
      seller: seller._id,
      name: 'Placeholder product',
      description: 'Placeholder description',
      price: 10,
      currency: 'PKR',
      priceCurrency: 'PKR',
      discountedPriceCurrency: 'PKR',
      category: 'Testing',
      brand: 'Testing',
      stock: 1,
      image: 'https://example.com/product.jpg',
      images: [{ url: 'https://example.com/product.jpg' }],
      isBlocked: true,
      moderationStatus: 'blocked',
      moderationReviewedAt: reviewedAt,
      moderationNotice: {
        reviewedAt,
        productName: 'Placeholder product',
        reason: 'placeholder content',
      },
    });
    const record = recordFor(seller, 'seller', {
      aggregateType: 'Product',
      aggregateId: String(product._id),
      eventType: 'product.blocked',
      occurredAt: reviewedAt,
    });

    await Product.updateOne({ _id: product._id }, {
      $set: {
        isBlocked: false,
        moderationStatus: 'approved',
        'moderationNotice.reviewedAt': null,
      },
    });
    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments()).toBe(0);
  });

  test('a store verification alert is skipped after a newer decision supersedes it', async () => {
    const seller = await User.create({
      username: 'verification-state-seller',
      email: 'verification-state-seller@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const approvedAt = new Date('2026-08-24T11:00:00.000Z');
    const removedAt = new Date('2026-08-24T12:00:00.000Z');
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Authority Store',
      storeSlug: 'authority-store',
      verification: {
        status: 'none',
        isVerified: false,
        reviewedAt: removedAt,
      },
    });
    const record = recordFor(seller, 'seller', {
      aggregateType: 'Store',
      aggregateId: String(store._id),
      eventType: 'store.verification_approved',
      occurredAt: approvedAt,
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments()).toBe(0);
  });

  test('a deleted review cannot produce a late new-review notification', async () => {
    const [seller, buyer] = await Promise.all([
      User.create({
        username: 'review-authority-seller',
        email: 'review-authority-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: 'review-authority-buyer',
        email: 'review-authority-buyer@example.com',
        password: 'password123',
        role: 'user',
        status: 'active',
      }),
    ]);
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Reviewed Store',
      storeSlug: 'reviewed-store',
    });
    const review = await StoreReview.create({
      store: store._id,
      user: buyer._id,
      rating: 5,
      isVerifiedPurchase: true,
    });
    const record = recordFor(seller, 'seller', {
      aggregateType: 'StoreReview',
      aggregateId: String(review._id),
      eventType: 'store.review_created',
      occurredAt: review.createdAt,
      payload: {
        title: 'New store rating',
        body: 'A verified buyer rated Reviewed Store 5 out of 5.',
        category: 'seller',
        linkTo: '/store/reviewed-store#store-reviews',
        data: { rating: 5 },
      },
    });
    await review.deleteOne();

    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments()).toBe(0);
  });

  test('a changed review rating cannot deliver a stale queued rating', async () => {
    const [seller, buyer] = await Promise.all([
      User.create({
        username: 'edited-review-seller',
        email: 'edited-review-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: 'edited-review-buyer',
        email: 'edited-review-buyer@example.com',
        password: 'password123',
        role: 'user',
        status: 'active',
      }),
    ]);
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Edited Review Store',
      storeSlug: 'edited-review-store',
    });
    const review = await StoreReview.create({
      store: store._id,
      user: buyer._id,
      rating: 5,
      isVerifiedPurchase: true,
    });
    const record = recordFor(seller, 'seller', {
      aggregateType: 'StoreReview',
      aggregateId: String(review._id),
      eventType: 'store.review_created',
      occurredAt: review.createdAt,
      payload: {
        title: 'New store rating',
        body: 'A verified buyer rated Edited Review Store 5 out of 5.',
        category: 'seller',
        linkTo: '/store/edited-review-store#store-reviews',
        data: { rating: 5 },
      },
    });
    await StoreReview.updateOne({ _id: review._id }, { $set: { rating: 2 } });

    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments()).toBe(0);
  });

  test('a queued plan-change action alert fails closed after the exact attempt completes', async () => {
    const seller = await User.create({
      username: 'completed-action-alert-seller',
      email: 'completed-action-alert-seller@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      planChangeAttempt: {
        idempotencyToken: 'attempt-action-stale',
        stripeInvoiceId: 'in_action_stale',
        targetPlan: 'elite',
        targetPlanName: 'Rozare Elite',
        targetUnitAmountMinor: 2165,
        state: 'pending_payment',
        notificationState: 'outboxed',
      },
    });
    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: { 'planChangeAttempt.state': 'applied' },
    });
    const record = recordFor(seller, 'seller', {
      aggregateType: 'SellerSubscription',
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_action_required',
      payload: {
        title: 'Payment authentication required',
        body: 'Authenticate the requested plan change.',
        category: 'subscription',
        linkTo: '/seller-dashboard/subscription',
        data: {
          attemptToken: 'attempt-action-stale',
          invoiceId: 'in_action_stale',
        },
      },
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
  });

  test('a queued payment-failure alert fails closed after recovery supersedes the invoice', async () => {
    const seller = await User.create({
      username: 'recovered-failure-alert-seller',
      email: 'recovered-failure-alert-seller@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'past_due',
      plan: 'starter',
      planName: 'Rozare Starter',
      paymentRisk: {
        suspended: true,
        latestFailureInvoiceId: 'in_failure_recovered',
        failureNotification: {
          invoiceId: 'in_failure_recovered',
          amountDueMinor: 999,
          currency: 'USD',
          occurredAt: new Date(),
          state: 'outboxed',
        },
      },
    });
    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        status: 'active',
        'paymentRisk.suspended': false,
        'paymentRisk.failureNotification.state': 'superseded',
      },
    });
    const record = recordFor(seller, 'seller', {
      aggregateType: 'SellerSubscription',
      aggregateId: String(subscription._id),
      eventType: 'subscription.payment_failed',
      recipient: {
        kind: 'user',
        audienceRole: 'seller',
        user: seller._id,
        destinationPolicy: 'current_user',
        allowBlocked: true,
      },
      payload: {
        title: 'Subscription payment failed',
        body: 'Payment is required.',
        category: 'subscription',
        linkTo: '/seller-dashboard/subscription',
        data: { invoiceId: 'in_failure_recovered' },
      },
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
  });

  test('actionable subscription alerts fail closed for a non-owner or forged audience', async () => {
    const [owner, otherSeller] = await Promise.all([
      User.create({
        username: 'subscription-alert-owner',
        email: 'subscription-alert-owner@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: 'subscription-alert-non-owner',
        email: 'subscription-alert-non-owner@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
    ]);
    const trialEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const subscription = await SellerSubscription.create({
      seller: owner._id,
      status: 'trial',
      plan: 'free_trial',
      trialEndDate,
    });
    const base = {
      aggregateType: 'SellerSubscription',
      aggregateId: String(subscription._id),
      eventType: 'subscription.trial_expiring',
      payload: {
        title: 'Seller trial ending soon',
        body: 'Review the exact trial expiry.',
        category: 'subscription',
        linkTo: '/seller-dashboard/subscription',
        data: { trialEndAt: trialEndDate.toISOString() },
      },
    };

    const nonOwner = await deliverNotificationRecord(recordFor(otherSeller, 'seller', base));
    const forgedAudience = await deliverNotificationRecord(recordFor(owner, 'buyer', base));

    expect(nonOwner).toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(forgedAudience).toEqual(expect.objectContaining({
      outcome: 'skipped',
      code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    }));
    expect(await Notification.countDocuments()).toBe(0);
  });

  test.each([
    ['subscription', 'subscription.payment_received', 'received', 'invoice_paid'],
    ['subscription', 'subscription.payment_recovered', 'recovered', 'invoice_paid'],
    ['subdomain', 'subdomain.payment_received', 'received', 'subdomain_paid'],
  ])('an exact %s %s receipt enforces immutable seller, timestamp, and money authority', async (
    entitlementType,
    eventType,
    kind,
    moneyKey,
  ) => {
    const [seller, otherSeller] = await Promise.all([
      User.create({
        username: `receipt-owner-${kind}-${entitlementType}`,
        email: `receipt-owner-${kind}-${entitlementType}@example.com`,
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: `receipt-other-${kind}-${entitlementType}`,
        email: `receipt-other-${kind}-${entitlementType}@example.com`,
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
    ]);
    const store = entitlementType === 'subdomain' ? await Store.create({
      seller: seller._id,
      storeName: 'Receipt Authority Store',
      storeSlug: `receipt-authority-${new mongoose.Types.ObjectId().toString().slice(-6)}`,
    }) : null;
    const occurredAt = new Date('2026-08-25T09:00:00.000Z');
    const payment = await StripeEntitlementPayment.create({
      entitlementType,
      sourceKey: `${entitlementType}:receipt:${new mongoose.Types.ObjectId()}`,
      seller: seller._id,
      store: store?._id,
      resourceKey: store?.storeSlug || '',
      paymentIntentId: `pi_receipt_${kind}_${entitlementType}`,
      invoiceId: entitlementType === 'subscription' ? `in_receipt_${kind}` : '',
      stripeSubscriptionId: entitlementType === 'subscription' ? `sub_receipt_${kind}` : '',
      capturedMinor: entitlementType === 'subscription' ? 999 : 1500,
      currency: 'usd',
      grantStart: new Date('2026-08-01T00:00:00.000Z'),
      grantEnd: new Date('2026-09-01T00:00:00.000Z'),
      effectiveGrantEnd: new Date('2026-09-01T00:00:00.000Z'),
      completionState: 'confirmed',
      paymentNotification: { kind, occurredAt, outboxEnqueuedAt: occurredAt },
    });
    const exact = recordFor(seller, 'seller', {
      eventKey: entitlementType === 'subscription'
        ? `subscription-payment:${payment._id}:${kind}:seller:v1`
        : `subdomain-payment:${payment._id}:seller:v1`,
      eventType,
      aggregateType: 'StripeEntitlementPayment',
      aggregateId: String(payment._id),
      occurredAt,
      financial: true,
      recipient: {
        kind: 'user', audienceRole: 'seller', user: seller._id,
        destinationPolicy: 'current_user', allowBlocked: true,
      },
      payload: {
        title: 'Payment receipt',
        body: 'Exact receipt amount.',
        category: 'payment',
        linkTo: '/seller-dashboard',
        data: {
          type: entitlementType === 'subscription'
            ? `subscription_payment_${kind}`
            : 'subdomain_payment_received',
          paymentId: String(payment._id),
          ...(store ? { storeId: String(store._id) } : {}),
        },
      },
      money: [{
        key: moneyKey,
        amountMinor: payment.capturedMinor,
        currency: 'USD',
        sourceModel: 'StripeEntitlementPayment',
        sourceDocumentId: String(payment._id),
        sourcePath: 'capturedMinor',
      }],
    });

    await expect(deliverNotificationRecord(exact)).resolves.toMatchObject({ outcome: 'delivered' });
    const drifted = { ...exact, money: [{ ...exact.money[0], amountMinor: payment.capturedMinor + 1 }] };
    await expect(deliverNotificationRecord(drifted)).resolves.toMatchObject({
      outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
    const wrongOwner = {
      ...exact,
      recipient: { ...exact.recipient, user: otherSeller._id },
    };
    await expect(deliverNotificationRecord(wrongOwner)).resolves.toMatchObject({
      outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
    const wrongTime = { ...exact, occurredAt: new Date(occurredAt.getTime() + 1000) };
    await expect(deliverNotificationRecord(wrongTime)).resolves.toMatchObject({
      outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
  });

  test('subscription activation delivery rejects money drift and a superseded entitlement', async () => {
    const seller = await User.create({
      username: 'activation-money-authority',
      email: 'activation-money-authority@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const occurredAt = new Date('2026-08-25T09:15:00.000Z');
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeSubscriptionId: 'sub_activation_money_authority',
      activationNotification: {
        kind: 'checkout_activation',
        sourceReference: 'cs_activation_money_authority',
        stripeSubscriptionId: 'sub_activation_money_authority',
        occurredAt,
        planName: 'Rozare Starter',
        recurringAmountMinor: 999,
        currency: 'USD',
        freePeriodDays: 0,
      },
    });
    const exact = recordFor(seller, 'seller', {
      eventType: 'subscription.activated',
      aggregateType: 'SellerSubscription',
      aggregateId: String(subscription._id),
      occurredAt,
      financial: true,
      payload: {
        title: 'Rozare Starter activated',
        body: 'Recurring price: $9.99 USD.',
        category: 'subscription',
        linkTo: '/seller-dashboard/subscription',
        data: { kind: 'checkout_activation' },
      },
      money: [{
        key: 'recurring_price',
        amountMinor: 999,
        currency: 'USD',
        sourceModel: 'SellerSubscription',
        sourceDocumentId: String(subscription._id),
        sourcePath: 'activationNotification.recurringAmountMinor',
      }],
    });
    await expect(deliverNotificationRecord(exact)).resolves.toMatchObject({ outcome: 'delivered' });

    const drifted = { ...exact, money: [{ ...exact.money[0], amountMinor: 1000 }] };
    await expect(deliverNotificationRecord(drifted)).resolves.toMatchObject({
      outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: { status: 'blocked', blockedReason: 'A newer terminal state.' },
    });
    await expect(deliverNotificationRecord(exact)).resolves.toMatchObject({
      outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE',
    });
  });

  test('Stripe risk receipts deliver only to an exact seller impact and reject money drift', async () => {
    const [impactSeller, secondImpactSeller, nonOwnerSeller] = await Promise.all([
      User.create({
        username: 'stripe-risk-impact-seller',
        email: 'stripe-risk-impact-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: 'stripe-risk-second-impact-seller',
        email: 'stripe-risk-second-impact-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: 'stripe-risk-non-owner-seller',
        email: 'stripe-risk-non-owner-seller@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
    ]);
    const riskEventId = new mongoose.Types.ObjectId();
    const occurredAt = new Date('2026-08-25T08:00:00.000Z');
    const riskEvent = {
      _id: riskEventId,
      classification: 'order_refund',
      sourceType: 'order_payment',
      occurredAt,
      order: new mongoose.Types.ObjectId(),
      currency: 'PKR',
      refundDeltaMinor: 5000,
      disputeExposureMinor: 0,
      accountImpact: null,
      sellerImpacts: [
        {
          seller: impactSeller._id,
          sourceAmountMinor: 2500,
          sourceCurrency: 'PKR',
          amountUSDMinor: 9,
        },
        {
          seller: secondImpactSeller._id,
          sourceAmountMinor: 2500,
          sourceCurrency: 'PKR',
          amountUSDMinor: 9,
        },
      ],
    };
    jest.spyOn(StripePaymentRiskEvent, 'findById').mockImplementation(() => ({
      select: () => ({ lean: async () => riskEvent }),
    }));
    const riskRecord = user => recordFor(user, 'seller', {
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: String(riskEventId),
      occurredAt,
      eventType: 'order.payment_refund_completed',
      financial: true,
      payload: {
        title: 'Order refund revenue adjustment',
        body: 'Frozen seller adjustment: Rs25.00 PKR.',
        category: 'payment',
        linkTo: '/seller-dashboard/payments',
        data: { riskEventId: String(riskEventId) },
      },
      money: [{
        key: 'seller_risk_impact',
        amountMinor: 2500,
        currency: 'PKR',
        sourceModel: 'StripePaymentRiskEvent',
        sourceDocumentId: String(riskEventId),
        sourcePath: 'sellerImpacts[0].sourceAmountMinor',
      }],
    });

    await expect(deliverNotificationRecord(riskRecord(impactSeller))).resolves.toEqual(
      expect.objectContaining({ outcome: 'delivered' }),
    );
    await expect(deliverNotificationRecord(riskRecord(nonOwnerSeller))).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    const drifted = riskRecord(impactSeller);
    drifted.money[0].amountMinor = 2501;
    await expect(deliverNotificationRecord(drifted)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    const otherSellerMoney = riskRecord(impactSeller);
    otherSellerMoney.money[0].sourcePath = 'sellerImpacts[1].sourceAmountMinor';
    await expect(deliverNotificationRecord(otherSellerMoney)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    expect(await Notification.countDocuments()).toBe(1);
  });

  test('entitlement refund receipts enforce the exact seller, provider evidence, and money intent', async () => {
    const [owner, otherSeller] = await Promise.all([
      User.create({
        username: 'entitlement-refund-owner',
        email: 'entitlement-refund-owner@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
      User.create({
        username: 'entitlement-refund-other',
        email: 'entitlement-refund-other@example.com',
        password: 'password123',
        role: 'seller',
        status: 'active',
      }),
    ]);
    const paymentId = new mongoose.Types.ObjectId();
    const occurredAt = new Date('2026-08-25T08:02:00.000Z');
    const intentKey = 'a'.repeat(64);
    const payment = {
      _id: paymentId,
      seller: owner._id,
      entitlementType: 'subscription',
      disputes: [],
      riskNotificationIntents: [{
        intentKey,
        eventId: 'evt_entitlement_refund_exact',
        eventType: 'charge.refunded',
        kind: 'refund',
        disputeState: '',
        occurredAt,
        chargeId: 'ch_entitlement_refund_exact',
        paymentIntentId: 'pi_entitlement_refund_exact',
        disputeId: '',
        amountMinor: 777,
        currency: 'usd',
        providerRefunds: [{
          refundId: 're_entitlement_refund_exact',
          amountMinor: 777,
          createdAt: occurredAt,
        }],
        state: 'outboxed',
        outboxEnqueuedAt: occurredAt,
      }],
    };
    jest.spyOn(StripeEntitlementPayment, 'findById').mockImplementation(() => ({
      select: () => ({ lean: async () => payment }),
    }));
    const refundRecord = user => recordFor(user, 'seller', {
      aggregateType: 'StripeEntitlementPayment',
      aggregateId: String(paymentId),
      eventKey: `stripe-entitlement-risk:${paymentId}:${intentKey}:seller:v1`,
      eventType: 'subscription.refund_confirmed',
      occurredAt,
      financial: true,
      recipient: {
        kind: 'user',
        audienceRole: 'seller',
        user: user._id,
        destinationPolicy: 'current_user',
        allowBlocked: true,
      },
      payload: {
        title: 'Subscription refund confirmed',
        body: 'Stripe confirmed a $7.77 USD refund.',
        category: 'payment',
        linkTo: '/seller-dashboard/subscription',
        data: {
          type: 'subscription_refund_confirmed',
          entitlementPaymentId: String(paymentId),
          providerEvent: 'evt_entitlement_refund_exact',
          providerReferences: ['re_entitlement_refund_exact'],
          outcome: 'refund',
        },
      },
      money: [{
        key: 'risk_amount',
        amountMinor: 777,
        currency: 'USD',
        sourceModel: 'StripeEntitlementPayment',
        sourceDocumentId: String(paymentId),
        sourcePath: 'riskNotificationIntents[0].amountMinor',
      }],
    });

    await expect(deliverNotificationRecord(refundRecord(owner))).resolves.toEqual(
      expect.objectContaining({ outcome: 'delivered' }),
    );
    await expect(deliverNotificationRecord(refundRecord(otherSeller))).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    const drifted = refundRecord(owner);
    drifted.money[0].amountMinor = 778;
    await expect(deliverNotificationRecord(drifted)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    const forgedProviderReference = refundRecord(owner);
    forgedProviderReference.payload.data.providerReferences = ['re_different_refund'];
    await expect(deliverNotificationRecord(forgedProviderReference)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    expect(await Notification.countDocuments()).toBe(1);
  });

  test('a queued entitlement dispute outcome is skipped after a newer terminal state', async () => {
    const seller = await User.create({
      username: 'entitlement-dispute-stale',
      email: 'entitlement-dispute-stale@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    const paymentId = new mongoose.Types.ObjectId();
    const occurredAt = new Date('2026-08-25T08:03:00.000Z');
    const intentKey = 'b'.repeat(64);
    jest.spyOn(StripeEntitlementPayment, 'findById').mockImplementation(() => ({
      select: () => ({
        lean: async () => ({
          _id: paymentId,
          seller: seller._id,
          entitlementType: 'subdomain',
          disputes: [{ disputeId: 'dp_entitlement_stale', state: 'won' }],
          riskNotificationIntents: [{
            intentKey,
            eventId: 'evt_entitlement_dispute_open',
            eventType: 'charge.dispute.created',
            kind: 'dispute_opened',
            disputeState: 'open',
            occurredAt,
            chargeId: 'ch_entitlement_dispute_open',
            paymentIntentId: 'pi_entitlement_dispute_open',
            disputeId: 'dp_entitlement_stale',
            amountMinor: 2000,
            currency: 'usd',
            providerRefunds: [],
            state: 'outboxed',
            outboxEnqueuedAt: occurredAt,
          }],
        }),
      }),
    }));
    const record = recordFor(seller, 'seller', {
      aggregateType: 'StripeEntitlementPayment',
      aggregateId: String(paymentId),
      eventKey: `stripe-entitlement-risk:${paymentId}:${intentKey}:seller:v1`,
      eventType: 'subdomain.dispute_opened',
      occurredAt,
      financial: true,
      recipient: {
        kind: 'user', audienceRole: 'seller', user: seller._id,
        destinationPolicy: 'current_user', allowBlocked: true,
      },
      payload: {
        title: 'Stripe dispute opened',
        body: 'Stripe opened a $20.00 USD dispute.',
        category: 'payment',
        linkTo: '/seller-dashboard/subdomain',
        data: {
          type: 'subdomain_dispute_opened',
          entitlementPaymentId: String(paymentId),
          providerEvent: 'evt_entitlement_dispute_open',
          providerReferences: ['dp_entitlement_stale'],
          outcome: 'dispute_opened',
        },
      },
      money: [{
        key: 'risk_amount', amountMinor: 2000, currency: 'USD',
        sourceModel: 'StripeEntitlementPayment',
        sourceDocumentId: String(paymentId),
        sourcePath: 'riskNotificationIntents[0].amountMinor',
      }],
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    expect(await Notification.countDocuments()).toBe(0);
  });

  test('Stripe order-refund receipts enforce the exact buyer or guest order owner', async () => {
    const [buyer, otherBuyer] = await Promise.all([
      User.create({
        username: 'stripe-risk-order-buyer',
        email: 'stripe-risk-order-buyer@example.com',
        password: 'password123',
        role: 'user',
        status: 'active',
      }),
      User.create({
        username: 'stripe-risk-other-buyer',
        email: 'stripe-risk-other-buyer@example.com',
        password: 'password123',
        role: 'user',
        status: 'active',
      }),
    ]);
    const riskEventId = new mongoose.Types.ObjectId();
    const orderId = new mongoose.Types.ObjectId();
    const occurredAt = new Date('2026-08-25T08:05:00.000Z');
    const riskEvent = {
      _id: riskEventId,
      classification: 'order_refund',
      sourceType: 'order_payment',
      occurredAt,
      order: orderId,
      currency: 'USD',
      refundDeltaMinor: 1200,
      disputeExposureMinor: 0,
      accountImpact: null,
      sellerImpacts: [],
    };
    jest.spyOn(StripePaymentRiskEvent, 'findById').mockImplementation(() => ({
      select: () => ({ lean: async () => riskEvent }),
    }));
    jest.spyOn(Order, 'findById').mockImplementation(() => ({
      select: () => ({ lean: async () => ({ _id: orderId, user: buyer._id }) }),
    }));
    const buyerRecord = user => recordFor(user, 'buyer', {
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: String(riskEventId),
      occurredAt,
      eventType: 'order.payment_refund_completed',
      financial: true,
      payload: {
        title: 'Card refund completed',
        body: 'Stripe confirmed a $12.00 USD refund.',
        category: 'payment',
        linkTo: `/user-dashboard/order/detail/${orderId}`,
        data: { riskEventId: String(riskEventId) },
      },
      money: [{
        key: 'refund_delta',
        amountMinor: 1200,
        currency: 'USD',
        sourceModel: 'StripePaymentRiskEvent',
        sourceDocumentId: String(riskEventId),
        sourcePath: 'refundDeltaMinor',
      }],
    });

    await expect(deliverNotificationRecord(buyerRecord(buyer))).resolves.toEqual(
      expect.objectContaining({ outcome: 'delivered' }),
    );
    await expect(deliverNotificationRecord(buyerRecord(otherBuyer))).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );

    const guestOrder = { _id: orderId, user: null };
    Order.findById.mockImplementation(() => ({
      select: () => ({ lean: async () => guestOrder }),
    }));
    const guestRecord = {
      ...buyerRecord(buyer),
      recipient: {
        kind: 'guest',
        audienceRole: 'buyer',
        guestKey: `order:${orderId}`,
        destinationPolicy: 'event_snapshot',
      },
    };
    await expect(verifyStripeRiskNotificationAuthority(guestRecord)).resolves.toBeNull();
    guestRecord.recipient.guestKey = `order:${new mongoose.Types.ObjectId()}`;
    await expect(verifyStripeRiskNotificationAuthority(guestRecord)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    expect(await Notification.countDocuments()).toBe(1);
  });

  test('Stripe Wallet-risk receipts enforce the exact top-up account owner', async () => {
    const [owner, otherBuyer] = await Promise.all([
      User.create({
        username: 'stripe-risk-wallet-owner',
        email: 'stripe-risk-wallet-owner@example.com',
        password: 'password123',
        role: 'user',
        status: 'active',
      }),
      User.create({
        username: 'stripe-risk-wallet-other',
        email: 'stripe-risk-wallet-other@example.com',
        password: 'password123',
        role: 'user',
        status: 'active',
      }),
    ]);
    const riskEventId = new mongoose.Types.ObjectId();
    const topUpId = new mongoose.Types.ObjectId();
    const occurredAt = new Date('2026-08-25T08:10:00.000Z');
    const riskEvent = {
      _id: riskEventId,
      classification: 'wallet_dispute_won_no_reserve',
      sourceType: 'wallet_top_up',
      occurredAt,
      walletTopUp: topUpId,
      currency: 'EUR',
      refundDeltaMinor: 0,
      disputeExposureMinor: 2000,
      accountImpact: null,
      sellerImpacts: [],
    };
    jest.spyOn(StripePaymentRiskEvent, 'findById').mockImplementation(() => ({
      select: () => ({ lean: async () => riskEvent }),
    }));
    jest.spyOn(WalletTransaction, 'findById').mockImplementation(() => ({
      select: () => ({ lean: async () => ({ _id: topUpId, user: owner._id }) }),
    }));
    const walletRecord = user => recordFor(user, 'buyer', {
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: String(riskEventId),
      occurredAt,
      eventType: 'wallet.payment_dispute_won',
      financial: true,
      payload: {
        title: 'Wallet top-up card dispute won',
        body: 'Stripe marked the EUR 20.00 dispute as won.',
        category: 'payment',
        linkTo: '/user-dashboard/wallet',
        data: { riskEventId: String(riskEventId) },
      },
      money: [{
        key: 'provider_amount',
        amountMinor: 2000,
        currency: 'EUR',
        sourceModel: 'StripePaymentRiskEvent',
        sourceDocumentId: String(riskEventId),
        sourcePath: 'disputeExposureMinor',
      }],
    });

    await expect(verifyStripeRiskNotificationAuthority(walletRecord(owner))).resolves.toBeNull();
    await expect(verifyStripeRiskNotificationAuthority(walletRecord(otherBuyer))).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
    riskEvent.accountImpact = {
      user: otherBuyer._id,
      sourceAmountMinor: 500,
      sourceCurrency: 'EUR',
    };
    const mismatchedAccountImpact = walletRecord(owner);
    mismatchedAccountImpact.money.push({
      key: 'account_impact',
      amountMinor: 500,
      currency: 'EUR',
      sourceModel: 'StripePaymentRiskEvent',
      sourceDocumentId: String(riskEventId),
      sourcePath: 'accountImpact.sourceAmountMinor',
    });
    await expect(verifyStripeRiskNotificationAuthority(mismatchedAccountImpact)).resolves.toEqual(
      expect.objectContaining({ outcome: 'skipped', code: 'NOTIFICATION_NO_LONGER_ACTIONABLE' }),
    );
  });

  test('COD confirmation WhatsApp delivery hands off to the interactive durable queue', async () => {
    const buyer = await User.create({
      username: 'cod-buyer',
      email: 'cod-buyer@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
    });
    const orderId = new mongoose.Types.ObjectId();
    const order = {
      _id: orderId,
      orderId: 'ORD-COD-1',
      user: buyer._id,
      paymentMethod: 'cash_on_delivery',
      isPaid: false,
      orderStatus: 'pending',
      currency: 'PKR',
      orderSummary: {
        subtotal: 1880,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1880,
      },
      orderItems: [{
        name: 'COD item',
        price: 1880,
        lineSubtotal: 1880,
        quantity: 1,
      }],
      shippingInfo: {
        phone: '+92 300 1234567',
        fullName: 'COD Buyer',
        city: 'Lahore',
      },
      confirmation: { token: 'a'.repeat(64) },
    };
    jest.spyOn(Order, 'findById').mockResolvedValue(order);
    const childJobId = new mongoose.Types.ObjectId();
    mockEnqueueOrderConfirmation.mockResolvedValueOnce({ _id: childJobId, status: 'queued' });
    const record = recordFor(buyer, 'buyer', {
      channel: 'whatsapp',
      eventType: 'order.confirmation_requested',
      recipient: {
        kind: 'user',
        audienceRole: 'buyer',
        user: buyer._id,
        destinationPolicy: 'event_snapshot',
        phone: '923001234567',
        allowBlocked: false,
      },
      payload: {
        message: 'This generic body must not replace the interactive controls.',
        category: 'order',
        relatedOrder: orderId,
        whatsappButtonsPayloadJson: JSON.stringify(buildOrderButtonsPayload(order)),
        whatsappListPayloadJson: JSON.stringify(buildOrderListPayload(order)),
      },
      money: [{
        key: 'order_total',
        label: 'Order total',
        amountMinor: 188000,
        currency: 'PKR',
        sourceModel: 'Order',
        sourceDocumentId: String(orderId),
        sourcePath: 'orderSummary.totalAmount',
      }],
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual({
      outcome: 'deferred',
      code: 'BUYER_WHATSAPP_JOB_PENDING',
      reason: 'The durable buyer WhatsApp job is still queued.',
    });
    mockFindOrderConfirmationJob.mockResolvedValueOnce({
      _id: childJobId,
      status: 'sent',
      summaryMessageId: 'evolution-message-1',
    });
    await expect(deliverNotificationRecord(record)).resolves.toEqual({
      outcome: 'delivered',
      providerMessageId: 'evolution-message-1',
    });
    expect(mockEnqueueOrderConfirmation).toHaveBeenCalledWith(order, {
      buttonsPayloadJson: record.payload.whatsappButtonsPayloadJson,
      listPayloadJson: record.payload.whatsappListPayloadJson,
    });
    expect(mockEnqueueOrderConfirmation).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
  });

  test('queued and sending child states defer, while a dead child terminalizes the parent', () => {
    expect(buyerWhatsAppJobOutcome({ _id: 'child-1', status: 'queued' })).toEqual({
      outcome: 'deferred',
      code: 'BUYER_WHATSAPP_JOB_PENDING',
      reason: 'The durable buyer WhatsApp job is still queued.',
    });
    expect(buyerWhatsAppJobOutcome({ _id: 'child-1', status: 'sending' })).toEqual({
      outcome: 'deferred',
      code: 'BUYER_WHATSAPP_JOB_PENDING',
      reason: 'The durable buyer WhatsApp job is still sending.',
    });
    expect(() => buyerWhatsAppJobOutcome({ _id: 'child-1', status: 'failed' }))
      .toThrow(expect.objectContaining({
        code: 'BUYER_WHATSAPP_JOB_FAILED',
        retryable: false,
      }));
  });

  test('buyer text retries replay through the child snapshot verifier', async () => {
    const buyer = await User.create({
      username: 'buyer-existing-child',
      email: 'buyer-existing-child@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
    });
    const orderId = new mongoose.Types.ObjectId();
    jest.spyOn(Order, 'findById').mockResolvedValue({
      _id: orderId,
      orderId: 'ORD-TEXT-CHILD',
      user: buyer._id,
      shippingInfo: { phone: '+92 300 1234567' },
    });
    mockEnqueueTextNotification.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      status: 'sent',
      summaryMessageId: 'existing-text-message',
    });
    const record = recordFor(buyer, 'buyer', {
      channel: 'whatsapp',
      eventType: 'return.status_updated',
      recipient: {
        kind: 'user', audienceRole: 'buyer', user: buyer._id,
        destinationPolicy: 'event_snapshot', phone: '923001234567', allowBlocked: false,
      },
      payload: {
        message: 'Your return status changed.',
        category: 'order',
        relatedOrder: orderId,
      },
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual({
      outcome: 'delivered',
      providerMessageId: 'existing-text-message',
    });
    expect(mockEnqueueTextNotification).toHaveBeenCalledWith({
      order: expect.objectContaining({ _id: orderId }),
      phone: '923001234567',
      message: record.payload.message,
      dedupeKey: `outbox:${record.dedupeKey}`,
    });
  });

  test('admin WhatsApp uses the verified current-user durable queue and cannot fall through to an order gateway', async () => {
    const admin = await User.create({
      username: 'wa-admin',
      email: 'wa-admin@example.com',
      password: 'password123',
      role: 'admin',
      status: 'active',
      whatsappInfo: { number: '923001234569', verified: true },
    });
    const record = recordFor(admin, 'admin', {
      channel: 'whatsapp',
      payload: { message: 'Administrative alert.', category: 'system' },
    });

    mockEnqueueGenericTextNotification.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(), status: 'queued',
    });
    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'deferred',
      code: 'CURRENT_USER_WHATSAPP_JOB_PENDING',
    }));
    expect(mockEnqueueGenericTextNotification).toHaveBeenCalledWith({
      phone: '923001234569',
      message: 'Administrative alert.',
      dedupeKey: `outbox:${record.dedupeKey}`,
      recipientLabel: 'wa-admin',
    });
    expect(mockEnqueueOrderConfirmation).not.toHaveBeenCalled();
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
  });

  test('Wallet buyer WhatsApp uses the verified current-user durable queue without inventing an Order owner', async () => {
    const buyer = await User.create({
      username: 'wallet-wa-buyer',
      email: 'wallet-wa-buyer@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
      whatsappInfo: { number: '923001234570', verified: true },
    });
    const childId = new mongoose.Types.ObjectId();
    mockEnqueueGenericTextNotification.mockResolvedValue({ _id: childId, status: 'queued' });
    const record = recordFor(buyer, 'buyer', {
      channel: 'whatsapp',
      eventType: 'wallet.completed',
      payload: {
        message: 'Your Wallet top-up completed.',
        category: 'payment',
        linkTo: '/user-dashboard/wallet',
      },
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual(expect.objectContaining({
      outcome: 'deferred',
      code: 'CURRENT_USER_WHATSAPP_JOB_PENDING',
    }));
    expect(mockEnqueueGenericTextNotification).toHaveBeenCalledWith({
      phone: '923001234570',
      message: record.payload.message,
      dedupeKey: `outbox:${record.dedupeKey}`,
      recipientLabel: 'wallet-wa-buyer',
    });
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
    expect(mockEnqueueOrderConfirmation).not.toHaveBeenCalled();
  });

  test('seller return WhatsApp uses only the seller gateway and preserves its provider id', async () => {
    const seller = await User.create({
      username: 'return-wa-seller',
      email: 'return-wa-seller@example.com',
      password: 'password123',
      role: 'seller',
      status: 'active',
    });
    mockNotifySeller.mockResolvedValue({
      sent: true,
      messageId: 'seller-evolution-message-1',
    });
    const record = recordFor(seller, 'seller', {
      channel: 'whatsapp',
      eventType: 'return.requested',
      payload: {
        message: 'A buyer opened return #RET-1001.',
        whatsappCategory: 'return_request',
        category: 'order',
      },
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual({
      outcome: 'delivered',
      providerMessageId: 'seller-evolution-message-1',
    });
    expect(mockNotifySeller).toHaveBeenCalledWith(
      seller._id,
      'return_request',
      'A buyer opened return #RET-1001.'
    );
    expect(mockEnqueueOrderConfirmation).not.toHaveBeenCalled();
    expect(mockEnqueueTextNotification).not.toHaveBeenCalled();
  });

  test('COD confirmation fails closed when current order money drifts from the outbox snapshot', async () => {
    const buyer = await User.create({
      username: 'cod-drift-buyer',
      email: 'cod-drift-buyer@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
    });
    const orderId = new mongoose.Types.ObjectId();
    const order = {
      _id: orderId,
      orderId: 'ORD-COD-DRIFT',
      user: buyer._id,
      paymentMethod: 'cash_on_delivery',
      isPaid: false,
      orderStatus: 'pending',
      currency: 'PKR',
      orderSummary: { totalAmount: 1881 },
      orderItems: [],
      shippingInfo: { phone: '+92 300 1234567' },
      confirmation: { token: 'a'.repeat(64) },
    };
    jest.spyOn(Order, 'findById').mockResolvedValue(order);
    const record = recordFor(buyer, 'buyer', {
      channel: 'whatsapp',
      eventType: 'order.confirmation_requested',
      recipient: {
        kind: 'user', audienceRole: 'buyer', user: buyer._id,
        destinationPolicy: 'event_snapshot', phone: '923001234567', allowBlocked: false,
      },
      payload: {
        message: 'Frozen total Rs1,880.00 PKR',
        category: 'order',
        relatedOrder: orderId,
        whatsappButtonsPayloadJson: JSON.stringify({ description: 'Rs1,880.00 PKR' }),
        whatsappListPayloadJson: JSON.stringify({ description: 'Rs1,880.00 PKR' }),
      },
      money: [{
        key: 'order_total', label: 'Order total', amountMinor: 188000, currency: 'PKR',
        sourceModel: 'Order', sourceDocumentId: String(orderId), sourcePath: 'orderSummary.totalAmount',
      }],
    });

    await expect(deliverNotificationRecord(record)).rejects.toMatchObject({
      code: 'COD_CONFIRMATION_MONEY_SNAPSHOT_DRIFT',
      retryable: false,
    });
    expect(mockEnqueueOrderConfirmation).not.toHaveBeenCalled();
  });

  test('a voted child job remains delivered even after the COD order is no longer actionable', async () => {
    const buyer = await User.create({
      username: 'cod-voted-buyer',
      email: 'cod-voted-buyer@example.com',
      password: 'password123',
      role: 'user',
      status: 'active',
    });
    const orderId = new mongoose.Types.ObjectId();
    const order = {
      _id: orderId,
      orderId: 'ORD-COD-VOTED',
      user: buyer._id,
      paymentMethod: 'cash_on_delivery',
      isPaid: false,
      orderStatus: 'confirmed',
      currency: 'PKR',
      orderSummary: { totalAmount: 1880 },
      orderItems: [],
      shippingInfo: { phone: '+92 300 1234567' },
      confirmation: {
        token: 'a'.repeat(64),
        confirmedAt: new Date('2026-08-24T10:00:00.000Z'),
      },
    };
    jest.spyOn(Order, 'findById').mockResolvedValue(order);
    mockFindOrderConfirmationJob.mockResolvedValue({
      _id: new mongoose.Types.ObjectId(),
      status: 'voted_yes',
      summaryMessageId: 'evolution-voted-message',
    });
    const record = recordFor(buyer, 'buyer', {
      channel: 'whatsapp',
      eventType: 'order.confirmation_requested',
      recipient: {
        kind: 'user', audienceRole: 'buyer', user: buyer._id,
        destinationPolicy: 'event_snapshot', phone: '923001234567', allowBlocked: false,
      },
      payload: {
        message: 'Frozen confirmation.',
        category: 'order',
        relatedOrder: orderId,
        whatsappButtonsPayloadJson: JSON.stringify({ description: 'Rs1,880.00 PKR' }),
        whatsappListPayloadJson: JSON.stringify({ description: 'Rs1,880.00 PKR' }),
      },
      money: [{
        key: 'order_total', label: 'Order total', amountMinor: 188000, currency: 'PKR',
        sourceModel: 'Order', sourceDocumentId: String(orderId), sourcePath: 'orderSummary.totalAmount',
      }],
    });

    await expect(deliverNotificationRecord(record)).resolves.toEqual({
      outcome: 'delivered',
      providerMessageId: 'evolution-voted-message',
    });
    expect(mockEnqueueOrderConfirmation).not.toHaveBeenCalled();
  });
});
