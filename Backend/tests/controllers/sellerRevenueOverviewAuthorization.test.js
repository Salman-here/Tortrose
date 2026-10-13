jest.mock('../../services/sellerRevenueOverviewService', () => ({ buildSellerRevenueOverview: jest.fn() }));
const { buildSellerRevenueOverview } = require('../../services/sellerRevenueOverviewService');
const { getSellerRevenueOverview } = require('../../controllers/PaymentController');
const response = () => { const res = {}; res.status = jest.fn(() => res); res.json = jest.fn(() => res); return res; };
beforeEach(() => jest.clearAllMocks());
test.each(['user', 'admin', undefined])('%s cannot access this seller-only reporting route', async role => {
  const res = response(); await getSellerRevenueOverview({ user: { id: 'owner', role }, query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(403); expect(buildSellerRevenueOverview).not.toHaveBeenCalled();
});
test('a seller-supplied different owner is ignored; only the authenticated owner is read', async () => {
  buildSellerRevenueOverview.mockResolvedValue({ sellerId: 'owner' });
  const res = response();
  await getSellerRevenueOverview({ user: { id: 'owner', role: 'seller' }, query: { sellerId: 'other', currency: 'PKR', days: '7' } }, res);
  expect(buildSellerRevenueOverview).toHaveBeenCalledWith('owner', { currency: 'PKR', days: '7' });
  expect(res.status).toHaveBeenCalledWith(200);
});
