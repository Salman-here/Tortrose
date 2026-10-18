'use strict';

jest.mock('../../models/SellerSubscription', () => ({ findOne: jest.fn() }));
const Subscription = require('../../models/SellerSubscription');
const bonusFeatureCheck = require('../../middleware/bonusFeatureCheck');

test.each(['cancelled', 'blocked', 'past_due'])('inactive %s sellers cannot use preserved premium access', async status => {
  const sub = { status, plan: 'starter', billingProvider: 'safepay', bonusFeaturesActive: true,
    bonusExpiryDate: new Date(Date.now() + 90 * 86400000), save: jest.fn() };
  Subscription.findOne.mockResolvedValue(sub);
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
  await bonusFeatureCheck('Advanced analytics')({ user: { role: 'seller', id: 'seller' } }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SUBSCRIPTION_ACCESS_REQUIRED' }));
  expect(next).not.toHaveBeenCalled();
  expect(sub.save).not.toHaveBeenCalled();
  expect(sub.bonusFeaturesActive).toBe(true);
});

test('a funded Starter without an active bonus allowance cannot fall through the gate', async () => {
  Subscription.findOne.mockResolvedValue({ status: 'active', plan: 'starter', bonusFeaturesActive: false });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
  await bonusFeatureCheck('Coupons')({ user: { role: 'seller', id: 'seller' } }, res, next);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'BONUS_ACCESS_REQUIRED' }));
  expect(next).not.toHaveBeenCalled();
});
