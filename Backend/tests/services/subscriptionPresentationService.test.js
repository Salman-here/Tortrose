const {
  buildSubscriptionStatusMessage,
  buildSubscriptionStatusPresentation,
  getSubscriptionCatalog,
} = require('../../services/subscriptionPresentationService');

describe('subscription presentation source of truth', () => {
  test('publishes exact pricing, limits, features, and lifecycle rules', () => {
    const catalog = getSubscriptionCatalog();

    expect(catalog).toMatchObject({
      schemaVersion: 1,
      trial: {
        days: 15,
        productListingLimit: 15,
        featuredProductLimit: 6,
        creditCardRequired: false,
        includesStarterFeatures: true,
        includesBonusFeatures: true,
      },
      starter: {
        productListingLimit: null,
        featuredProductLimit: 6,
        bonusFeaturesMonths: 6,
        bonusPeriodIsOneTime: true,
      },
      elite: {
        productListingLimit: null,
        featuredProductLimit: 12,
        bonusFeaturesPermanent: true,
      },
      bonusGraceDays: 3,
      founderPromotion: {
        code: 'FIRST100',
        discountPercent: 40,
        maxRedemptions: 100,
        checkoutReservationMinutes: 35,
        claimTiming: 'stripe_checkout_completed',
        entitlementPersistence: 'while_subscription_remains_uninterrupted',
      },
      pricing: {
        currency: 'USD',
        metaAdsAddonCents: 400,
        starter: {
          listAmountCents: 1175,
          standardAmountCents: 999,
          founderAmountCents: 599,
          advertisedDiscountPercent: 15,
          freePeriodDays: 30,
        },
        elite: {
          listAmountCents: 3093,
          standardAmountCents: 2165,
          founderAmountCents: 1299,
          advertisedDiscountPercent: 30,
          freePeriodDays: 45,
        },
      },
      billing: {
        upgradeTiming: 'immediate',
        downgradeTiming: 'period_end',
        cancellationTiming: 'period_end',
        introductoryPeriodIsOneTime: true,
      },
      afterAccessEnds: {
        publicStoreVisible: false,
        productsVisible: false,
        sellerDashboardAccessible: true,
        sellerDataPreserved: true,
      },
    });
    expect(catalog.features.trial).toContain('Up to 15 product listings during the free trial');
    expect(catalog.features.starter).toContain('Unlimited product listings');
    expect(catalog.features.bonus).toContain('Advanced analytics and growth insights');
    expect(catalog.features.eliteOnly).toContain('Rozare-run TikTok ads for your store and featured products');

    catalog.features.starter.push('mutation attempt');
    expect(getSubscriptionCatalog().features.starter).not.toContain('mutation attempt');
  });

  test('builds the complete seller-specific snapshot used by dashboard and AI', () => {
    const now = new Date('2026-09-04T00:00:00.000Z');
    const subscription = buildSubscriptionStatusPresentation({
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      trialStartDate: new Date('2026-07-01T00:00:00.000Z'),
      trialEndDate: new Date('2026-07-16T00:00:00.000Z'),
      subscribedAt: new Date('2026-07-16T00:00:00.000Z'),
      currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      cancelledAt: new Date('2026-08-20T00:00:00.000Z'),
      blockedReason: 'Subscription ended.',
      bonusFeaturesActive: true,
      starterBonusPeriodUsed: true,
      bonusExpiryDate: new Date('2027-01-16T00:00:00.000Z'),
      bonusGraceDeadline: new Date('2026-09-06T00:00:00.000Z'),
      pendingDowngrade: { toPlan: 'starter' },
      hasUsedFreePeriod: true,
      metaAdsIncluded: false,
      founderOffer: {
        active: true,
        code: 'FIRST100',
        claimedAt: new Date('2026-07-16T00:00:00.000Z'),
      },
    }, {
      now,
      founderDiscountPercent: 40,
      founderPromotion: { code: 'FIRST100', available: true, remaining: 9 },
    });

    expect(subscription).toMatchObject({
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      isBlocked: true,
      blockedReason: 'Subscription ended.',
      bonusFeaturesActive: true,
      starterBonusPeriodUsed: true,
      bonusGraceDaysRemaining: 2,
      pendingDowngrade: 'starter',
      hasUsedFreePeriod: true,
      metaAdsIncluded: false,
      aiMessagesUnlimited: true,
      founderOffer: { active: true, code: 'FIRST100', discountPercent: 40 },
      founderPromotion: { code: 'FIRST100', remaining: 9 },
    });
    expect(subscription.catalog.features.starter).toContain('Unlimited seller AI chat');
    expect(buildSubscriptionStatusMessage(subscription)).toContain('Subscription ended.');
    expect(buildSubscriptionStatusMessage(subscription)).toContain('Unused Starter bonus time is preserved');
  });

  test('uses the 15-day trial fallback without marking an ended trial as expiring soon', () => {
    const trial = { status: 'trial', plan: 'free_trial', trialStartDate: '2026-09-01T00:00:00.000Z' };
    const expiring = buildSubscriptionStatusPresentation(trial, {
      now: new Date('2026-09-15T00:00:00.000Z'),
    });
    const ended = buildSubscriptionStatusPresentation(trial, {
      now: new Date('2026-09-16T00:00:00.000Z'),
    });

    expect(expiring).toMatchObject({ trialDaysRemaining: 1, isTrialExpiringSoon: true });
    expect(expiring.trialEndDate.toISOString()).toBe('2026-09-16T00:00:00.000Z');
    expect(ended).toMatchObject({ trialDaysRemaining: 0, isTrialExpiringSoon: false });
  });

  test('reports the exact current recurring amount only while a recurring plan is live', () => {
    const active = buildSubscriptionStatusPresentation({
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      metaAdsIncluded: true,
      founderOffer: { active: true, code: 'FIRST100' },
    }, { founderDiscountPercent: 40 });
    const blocked = buildSubscriptionStatusPresentation({
      status: 'blocked',
      plan: 'elite',
      planName: 'Rozare Elite',
      metaAdsIncluded: true,
      founderOffer: { active: false },
    });

    expect(active.currentMonthlyAmountCents).toBe(1699);
    expect(buildSubscriptionStatusMessage(active)).toContain('$16.99 USD per month, including the Meta ads add-on');
    expect(blocked.currentMonthlyAmountCents).toBeNull();
  });
});
