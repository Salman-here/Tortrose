const { seller } = require('../../middleware/authMiddleware');
const bonusFeatureCheck = require('../../middleware/bonusFeatureCheck');
const SellerSubscription = require('../../models/SellerSubscription');
const couponRoutes = require('../../routes/couponRoutes');

const routeMiddleware = (path, method) => {
  const layer = couponRoutes.stack.find(entry => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  expect(layer).toBeTruthy();
  return layer.route.stack.map(entry => entry.handle);
};

describe('coupon seller authorization and entitlement boundaries', () => {
  test.each([
    ['/create', 'post'],
    ['/seller', 'get'],
    ['/analytics', 'get'],
    ['/update/:id', 'put'],
    ['/delete/:id', 'delete'],
    ['/toggle/:id', 'patch'],
  ])('requires the live seller role before %s', (path, method) => {
    expect(routeMiddleware(path, method)[1]).toBe(seller);
  });

  test('fails closed when a seller entitlement lookup errors', async () => {
    const databaseError = new Error('subscription database unavailable');
    const lookup = jest.spyOn(SellerSubscription, 'findOne').mockRejectedValueOnce(databaseError);
    const middleware = bonusFeatureCheck('Coupon Management');
    const req = { user: { id: 'seller-id', role: 'seller' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BONUS_ENTITLEMENT_UNAVAILABLE',
    }));
    expect(next).not.toHaveBeenCalled();
    lookup.mockRestore();
  });
});
