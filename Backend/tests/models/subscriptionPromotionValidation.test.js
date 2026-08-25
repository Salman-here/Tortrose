'use strict';

const mongoose = require('mongoose');
const SubscriptionPromotion = require('../../models/SubscriptionPromotion');

const VALID_TOKEN = '123e4567-e89b-42d3-a456-426614174000';

const basePromotion = overrides => new SubscriptionPromotion({
  code: 'FIRST100',
  name: 'First 100 Sellers',
  discountPercent: 40,
  maxRedemptions: 100,
  claims: [],
  reservations: [],
  ...overrides,
});

const validClaim = overrides => ({
  seller: new mongoose.Types.ObjectId(),
  claimedAt: new Date('2026-08-24T10:00:00.000Z'),
  source: 'coupon',
  checkoutSessionId: 'cs_test_claim',
  ...overrides,
});

const validReservation = overrides => ({
  seller: new mongoose.Types.ObjectId(),
  token: VALID_TOKEN,
  checkoutSessionId: null,
  createdAt: new Date('2026-08-24T10:00:00.000Z'),
  expiresAt: new Date('2026-08-24T10:35:00.000Z'),
  ...overrides,
});

describe('subscription promotion schema integrity', () => {
  test('accepts an exact Stripe-compatible percentage and well-formed claim/reservation authority', async () => {
    const promotion = basePromotion({
      discountPercent: 25.5,
      claims: [validClaim()],
      reservations: [validReservation({ checkoutSessionId: 'cs_live_pending_123' })],
      legacyMigrationCompletedAt: new Date('2026-08-24T11:00:00.000Z'),
    });

    await expect(promotion.validate()).resolves.toBeUndefined();
    expect(promotion.discountPercent).toBe(25.5);
    expect(promotion.maxRedemptions).toBe(100);
  });

  test.each([true, '40', '', Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 100.001, 101])(
    'rejects unsafe promotion discount %p without coercion',
    value => {
      const error = basePromotion({ discountPercent: value }).validateSync();
      expect(error?.errors).toHaveProperty('discountPercent');
    },
  );

  test.each([true, '100', '', Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe promotion redemption limit %p without coercion',
    value => {
      const error = basePromotion({ maxRedemptions: value }).validateSync();
      expect(error?.errors).toHaveProperty('maxRedemptions');
    },
  );

  test.each([
    true,
    '',
    'not-a-token',
    '123e4567-e89b-12d3-a456-426614174000',
    `${VALID_TOKEN}x`,
  ])('rejects malformed reservation token %p', value => {
    const error = basePromotion({
      reservations: [validReservation({ token: value })],
    }).validateSync();
    expect(error?.errors?.['reservations.0.token']).toBeDefined();
  });

  test.each([
    ['claims', validClaim({ claimedAt: '2026-08-24T10:00:00.000Z' }), 'claims.0.claimedAt'],
    ['claims', validClaim({ claimedAt: Number(Date.now()) }), 'claims.0.claimedAt'],
    ['claims', validClaim({ claimedAt: new Date(Number.NaN) }), 'claims.0.claimedAt'],
    ['reservations', validReservation({ createdAt: '2026-08-24T10:00:00.000Z' }), 'reservations.0.createdAt'],
    ['reservations', validReservation({ expiresAt: true }), 'reservations.0.expiresAt'],
    ['reservations', validReservation({ expiresAt: new Date(Number.NaN) }), 'reservations.0.expiresAt'],
  ])('rejects non-Date or invalid %s authority timestamps', (field, entry, expectedPath) => {
    const error = basePromotion({ [field]: [entry] }).validateSync();
    expect(error?.errors?.[expectedPath]).toBeDefined();
  });

  test('rejects a reservation window that does not end after it starts', () => {
    const createdAt = new Date('2026-08-24T10:00:00.000Z');
    const error = basePromotion({
      reservations: [validReservation({ createdAt, expiresAt: new Date(createdAt) })],
    }).validateSync();
    expect(error?.errors?.['reservations.0.expiresAt']).toBeDefined();
  });

  test.each([true, '', 'pi_not_a_checkout_session', 'cs_bad value']) (
    'rejects malformed Checkout Session authority %p',
    value => {
      const claimError = basePromotion({
        claims: [validClaim({ checkoutSessionId: value })],
      }).validateSync();
      const reservationError = basePromotion({
        reservations: [validReservation({ checkoutSessionId: value })],
      }).validateSync();

      expect(claimError?.errors?.['claims.0.checkoutSessionId']).toBeDefined();
      expect(reservationError?.errors?.['reservations.0.checkoutSessionId']).toBeDefined();
    },
  );
});
