jest.mock('../../models/Store', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/Product', () => ({ find: jest.fn() }));
jest.mock('../../models/Order', () => ({ find: jest.fn() }));
jest.mock('../../models/User', () => ({}));

const Store = require('../../models/Store');
const { admin, seller } = require('../../middleware/authMiddleware');
const subdomainRoutes = require('../../routes/subdomain');
const {
  getAllSubdomains,
  adminUpdateSubdomain,
  getSellerSubdomainAnalytics,
} = require('../../controllers/subdomainController');

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

describe('subdomain administration authorization', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([undefined, 'user', 'seller'])(
    'blocks %s role from listing platform subdomains before database access',
    async (role) => {
      const response = responseMock();
      await getAllSubdomains({ user: role ? { id: 'user-1', role } : undefined, query: {} }, response);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(response.json).toHaveBeenCalledWith({
        msg: 'Access denied. Admin privileges required.',
      });
      expect(Store.find).not.toHaveBeenCalled();
      expect(Store.countDocuments).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, 'user', 'seller'])(
    'blocks %s role from changing another store subdomain before database access',
    async (role) => {
      const response = responseMock();
      await adminUpdateSubdomain({
        user: role ? { id: 'user-1', role } : undefined,
        params: { storeId: 'store-1' },
        body: { newSlug: 'stolen-store' },
      }, response);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(Store.findOne).not.toHaveBeenCalled();
      expect(Store.findById).not.toHaveBeenCalled();
    },
  );

  test('registers admin authorization before both controller handlers', () => {
    const listRoute = subdomainRoutes.stack.find((layer) => layer.route?.path === '/admin/all');
    const updateRoute = subdomainRoutes.stack.find((layer) => layer.route?.path === '/admin/:storeId/update-slug');

    expect(listRoute.route.stack[1].handle).toBe(admin);
    expect(updateRoute.route.stack[1].handle).toBe(admin);
  });

  test.each([undefined, 'user', 'admin'])(
    'blocks %s role from seller analytics before store access',
    async (role) => {
      const response = responseMock();
      await getSellerSubdomainAnalytics({
        user: role ? { id: 'user-1', role } : undefined,
        query: {},
      }, response);

      expect(response.status).toHaveBeenCalledWith(403);
      expect(Store.findOne).not.toHaveBeenCalled();
    },
  );

  test('registers seller authorization before subdomain analytics', () => {
    const route = subdomainRoutes.stack.find((layer) => layer.route?.path === '/analytics/seller');
    expect(route.route.stack[1].handle).toBe(seller);
  });
});
