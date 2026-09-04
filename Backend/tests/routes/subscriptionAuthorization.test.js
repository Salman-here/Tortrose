const { admin, seller } = require('../../middleware/authMiddleware');
const subscriptionRoutes = require('../../routes/subscriptionRoutes');

const routeMiddleware = (path, method) => {
  const layer = subscriptionRoutes.stack.find((entry) => (
    entry.route?.path === path && entry.route?.methods?.[method]
  ));
  expect(layer).toBeTruthy();
  return layer.route.stack.map((entry) => entry.handle);
};

describe('subscription route authorization boundaries', () => {
  test.each([
    ['/status', 'get'],
    ['/create-checkout', 'post'],
    ['/cancel', 'post'],
    ['/resume', 'post'],
    ['/upgrade-to-elite', 'post'],
    ['/downgrade-to-starter', 'post'],
    ['/cancel-downgrade', 'post'],
    ['/subdomain/ownership', 'get'],
    ['/subdomain/purchase', 'post'],
  ])('requires seller authorization for %s', (path, method) => {
    expect(routeMiddleware(path, method)[1]).toBe(seller);
  });

  test('requires administrator authorization for the platform subscription list', () => {
    expect(routeMiddleware('/admin/all', 'get')[1]).toBe(admin);
  });

  test('keeps the fixed mobile return bridge public', () => {
    const middleware = routeMiddleware('/mobile-return', 'get');
    expect(middleware).toHaveLength(1);
    expect(middleware).not.toContain(seller);
    expect(middleware).not.toContain(admin);
  });

  test('keeps the read-only subscription catalog public', () => {
    const middleware = routeMiddleware('/catalog', 'get');
    expect(middleware).toHaveLength(1);
    expect(middleware).not.toContain(seller);
    expect(middleware).not.toContain(admin);
  });
});
