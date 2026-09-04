jest.mock('../../controllers/subscriptionController', () => ({
  getSellerSubscriptionStatusData: jest.fn(),
}));

const {
  getSellerSubscriptionStatusData,
} = require('../../controllers/subscriptionController');
const { executeToolCall } = require('../../services/aiActionExecutor');

describe('AI subscription truth tools', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lets every role read the exact public subscription catalog', async () => {
    const result = await executeToolCall('get_subscription_catalog', {}, { role: 'guest' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      trial: { days: 15, productListingLimit: 15 },
      starter: { featuredProductLimit: 6, bonusFeaturesMonths: 6 },
      elite: { featuredProductLimit: 12, bonusFeaturesPermanent: true },
      bonusGraceDays: 3,
      founderPromotion: {
        code: 'FIRST100',
        discountPercent: 40,
        maxRedemptions: 100,
        checkoutReservationMinutes: 35,
      },
      pricing: {
        starter: { standardAmountCents: 999, freePeriodDays: 30 },
        elite: { standardAmountCents: 2165, freePeriodDays: 45 },
        metaAdsAddonCents: 400,
      },
    });
  });

  test('returns the complete resolved seller status without rebuilding a partial snapshot', async () => {
    const snapshot = {
      plan: 'starter',
      planName: 'Rozare Starter',
      status: 'active',
      currentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      hasUsedFreePeriod: true,
      pendingDowngrade: null,
      bonusFeaturesActive: true,
      bonusExpiryDate: new Date('2027-02-01T00:00:00.000Z'),
      bonusGraceDaysRemaining: 0,
      metaAdsIncluded: false,
      founderOffer: { active: true, code: 'FIRST100' },
      founderPromotion: { available: true, remaining: 8 },
      catalog: { trial: { productListingLimit: 15 } },
    };
    getSellerSubscriptionStatusData.mockResolvedValue(snapshot);

    const result = await executeToolCall(
      'get_subscription_status',
      {},
      { id: '507f1f77bcf86cd799439011', role: 'seller', currency: 'USD' },
    );

    expect(getSellerSubscriptionStatusData).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
    expect(result).toEqual(expect.objectContaining({ success: true, data: snapshot }));
    expect(result.message).toContain('Rozare Starter (active)');
  });

  test('does not initialize or expose seller-specific status for a non-seller account', async () => {
    const result = await executeToolCall(
      'get_subscription_status',
      {},
      { id: '507f1f77bcf86cd799439012', role: 'admin', currency: 'USD' },
    );

    expect(result).toEqual({
      success: false,
      error: 'A seller account is required to view seller-specific subscription status.',
    });
    expect(getSellerSubscriptionStatusData).not.toHaveBeenCalled();
  });
});
