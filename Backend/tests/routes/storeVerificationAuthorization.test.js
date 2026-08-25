const Store = require('../../models/Store');
const storeController = require('../../controllers/storeController');
const storeRoutes = require('../../routes/storeRoutes');
const verifyToken = require('../../middleware/authMiddleware');
const { admin } = require('../../middleware/authMiddleware');

const responseMock = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const middlewareFor = (path, method) => {
  const layer = storeRoutes.stack.find(entry => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  expect(layer).toBeTruthy();
  return layer.route.stack.map(entry => entry.handle);
};

describe('store verification admin authorization', () => {
  test.each([
    ['/verification/pending', 'get'],
    ['/verification/verified', 'get'],
    ['/verification/:storeId/approve', 'put'],
    ['/verification/:storeId/reject', 'put'],
    ['/verification/:storeId/remove', 'put'],
  ])('%s is protected by both live authentication and live admin middleware', (path, method) => {
    const middleware = middlewareFor(path, method);
    expect(middleware[0]).toBe(verifyToken);
    expect(middleware[1]).toBe(admin);
  });

  test('controller-level guards prevent a non-admin from reaching any verification query or mutation', async () => {
    const findSpy = jest.spyOn(Store, 'find');
    const findByIdSpy = jest.spyOn(Store, 'findById');
    const req = {
      user: { id: 'authenticated-buyer', role: 'user', status: 'active' },
      params: { storeId: 'target-store' },
      body: {},
    };

    for (const controller of [
      storeController.getPendingVerifications,
      storeController.getVerifiedStores,
      storeController.approveVerification,
      storeController.rejectVerification,
      storeController.removeVerification,
    ]) {
      const res = responseMock();
      await controller(req, res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
    }

    expect(findSpy).not.toHaveBeenCalled();
    expect(findByIdSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
    findByIdSpy.mockRestore();
  });

  test('controller-level guards also reject a stale blocked admin identity', async () => {
    const findSpy = jest.spyOn(Store, 'find');
    const res = responseMock();

    await storeController.getPendingVerifications({
      user: { id: 'blocked-admin', role: 'admin', status: 'blocked' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ACCOUNT_BLOCKED' }));
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });
});
