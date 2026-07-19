const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;
let SubscriptionPromotion;
let SellerSubscription;
let service;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  SubscriptionPromotion = require('../../models/SubscriptionPromotion');
  SellerSubscription = require('../../models/SellerSubscription');
  service = require('../../services/founderPromotionService');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await SubscriptionPromotion.deleteMany({});
  await SellerSubscription.deleteMany({});
  await service.ensureFounderPromotion();
});

describe('founder promotion capacity', () => {
  test('atomically allows only one seller to take the 100th slot', async () => {
    const claims = Array.from({ length: 99 }, () => ({
      seller: new mongoose.Types.ObjectId(),
      claimedAt: new Date(),
      source: 'coupon',
      checkoutSessionId: null,
    }));
    await SubscriptionPromotion.updateOne(
      { code: service.FOUNDER_PROMOTION.code },
      { $set: { claims } }
    );

    const results = await Promise.allSettled([
      service.reserveFounderSlot(new mongoose.Types.ObjectId()),
      service.reserveFounderSlot(new mongoose.Types.ObjectId()),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('FOUNDER_COUPON_FULL');

    const promotion = await SubscriptionPromotion.findOne({ code: service.FOUNDER_PROMOTION.code }).lean();
    expect(promotion.claims).toHaveLength(99);
    expect(promotion.reservations).toHaveLength(1);
  });

  test('releases an abandoned Checkout reservation for another seller', async () => {
    const firstSeller = new mongoose.Types.ObjectId();
    const reservation = await service.reserveFounderSlot(firstSeller);
    await service.attachCheckoutSessionToReservation(firstSeller, reservation.token, 'cs_abandoned');
    await service.releaseFounderReservation({
      sellerId: firstSeller,
      token: reservation.token,
      checkoutSessionId: 'cs_abandoned',
    });

    const status = await service.getFounderPromotionStatus();
    expect(status.claimedCount).toBe(0);
    expect(status.reservedCount).toBe(0);
    expect(status.remaining).toBe(100);
  });

  test('does not replace a completed Checkout reservation before its webhook arrives', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const reservation = await service.reserveFounderSlot(sellerId);
    await service.attachCheckoutSessionToReservation(sellerId, reservation.token, 'cs_processing');

    await expect(service.reserveFounderSlot(sellerId)).rejects.toMatchObject({
      code: 'FOUNDER_CHECKOUT_PENDING',
    });

    const promotion = await SubscriptionPromotion.findOne({ code: service.FOUNDER_PROMOTION.code }).lean();
    expect(promotion.reservations).toHaveLength(1);
    expect(promotion.reservations[0].checkoutSessionId).toBe('cs_processing');
  });

  test('keeps a seller eligible to retry while their own slot is reserved', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const claims = Array.from({ length: 99 }, () => ({
      seller: new mongoose.Types.ObjectId(),
      claimedAt: new Date(),
      source: 'coupon',
      checkoutSessionId: null,
    }));
    await SubscriptionPromotion.updateOne(
      { code: service.FOUNDER_PROMOTION.code },
      { $set: { claims } }
    );
    const reservation = await service.reserveFounderSlot(sellerId);
    await service.attachCheckoutSessionToReservation(sellerId, reservation.token, 'cs_retry');

    const subscription = await SellerSubscription.create({ seller: sellerId });
    const status = await service.getFounderPromotionStatus(subscription);

    expect(status.remaining).toBe(0);
    expect(status.available).toBe(true);
    expect(status.sellerEligible).toBe(true);
    expect(status.sellerHasReservation).toBe(true);
  });

  test('claims a reservation once and treats duplicate webhook delivery as success', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const reservation = await service.reserveFounderSlot(sellerId);
    await service.attachCheckoutSessionToReservation(sellerId, reservation.token, 'cs_founder');

    const first = await service.claimFounderReservation({
      sellerId,
      token: reservation.token,
      checkoutSessionId: 'cs_founder',
    });
    const duplicate = await service.claimFounderReservation({
      sellerId,
      token: reservation.token,
      checkoutSessionId: 'cs_founder',
    });

    expect(first.claimed).toBe(true);
    expect(duplicate).toMatchObject({ claimed: true, alreadyClaimed: true });
    const promotion = await SubscriptionPromotion.findOne({ code: service.FOUNDER_PROMOTION.code }).lean();
    expect(promotion.claims).toHaveLength(1);
    expect(promotion.reservations).toHaveLength(0);
  });

  test('never gives a second founder redemption to the same seller', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const reservation = await service.reserveFounderSlot(sellerId);
    await service.attachCheckoutSessionToReservation(sellerId, reservation.token, 'cs_once');
    await service.claimFounderReservation({
      sellerId,
      token: reservation.token,
      checkoutSessionId: 'cs_once',
    });

    await expect(service.reserveFounderSlot(sellerId)).rejects.toMatchObject({
      code: 'FOUNDER_COUPON_ALREADY_USED',
    });
  });

  test('does not let a different Checkout reuse an existing founder claim', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const reservation = await service.reserveFounderSlot(sellerId);
    await service.attachCheckoutSessionToReservation(sellerId, reservation.token, 'cs_original');
    await service.claimFounderReservation({
      sellerId,
      token: reservation.token,
      checkoutSessionId: 'cs_original',
    });

    await expect(service.claimFounderReservation({
      sellerId,
      token: 'different-token',
      checkoutSessionId: 'cs_different',
    })).rejects.toMatchObject({ code: 'FOUNDER_COUPON_ALREADY_USED' });
  });

  test('migrates an existing free-period subscriber into one real founder claim', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    await SellerSubscription.create({
      seller: sellerId,
      status: 'free_period',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeSubscriptionId: 'sub_existing',
      subscribedAt: new Date('2026-07-01T00:00:00.000Z'),
      hasUsedFreePeriod: true,
    });

    const firstRun = await service.migrateLegacyFounderSubscribers();
    const secondRun = await service.migrateLegacyFounderSubscribers();
    const subscription = await SellerSubscription.findOne({ seller: sellerId }).lean();
    const promotion = await SubscriptionPromotion.findOne({ code: service.FOUNDER_PROMOTION.code }).lean();

    expect(firstRun).toMatchObject({ migrated: 1, alreadyCompleted: false });
    expect(secondRun).toMatchObject({ migrated: 0, alreadyCompleted: true });
    expect(subscription.founderOffer).toMatchObject({
      active: true,
      code: 'FIRST100',
      discountPercent: 40,
      source: 'legacy',
    });
    expect(promotion.claims).toHaveLength(1);
    expect(promotion.claims[0].source).toBe('legacy');
  });

  test('does not grandfather a subscription created after the promotion launch cutoff', async () => {
    const promotion = await SubscriptionPromotion.findOne({ code: service.FOUNDER_PROMOTION.code });
    const sellerId = new mongoose.Types.ObjectId();
    await SellerSubscription.create({
      seller: sellerId,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeSubscriptionId: 'sub_new_standard',
      subscribedAt: new Date(promotion.createdAt.getTime() + 60 * 1000),
      hasUsedFreePeriod: true,
    });

    const result = await service.migrateLegacyFounderSubscribers();
    const subscription = await SellerSubscription.findOne({ seller: sellerId }).lean();

    expect(result.migrated).toBe(0);
    expect(subscription.founderOffer.active).toBe(false);
    expect(subscription.founderOffer.claimedAt).toBeNull();
  });
});
