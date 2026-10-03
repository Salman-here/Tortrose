const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockAttach = jest.fn();
jest.mock('../../models/Order', () => ({ find: mockFind, findOne: mockFindOne }));
jest.mock('../../services/buyerOrderPresentationService', () => ({ buildBuyerOrderView: value => value }));
jest.mock('../../services/safepaySafetyRefundPresentationService', () => ({
  ...jest.requireActual('../../services/safepaySafetyRefundPresentationService'), attachSafetyRefundViews: mockAttach,
}));
const { getUserOrders, getOrderDetail } = require('../../controllers/orderController');
const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() });
beforeEach(() => { jest.clearAllMocks(); mockFind.mockResolvedValue([]); mockAttach.mockImplementation(async rows => rows); });
test('buyer list stays purchaser-scoped and combines visibility with the existing filters', async () => {
  const res = response();
  await getUserOrders({ user: { id: 'buyer-a', role: 'seller' }, query: { user: 'victim', search: 'ORD', status: 'cancelled', paymentStatus: 'unpaid' } }, res);
  const filter = mockFind.mock.calls[0][0];
  expect(filter.user).toBe('buyer-a'); expect(filter.orderStatus).toBe('cancelled'); expect(filter.isPaid).toBe(false);
  expect(filter.$and[0].$or).toEqual([{ awaitingPayment: { $ne: true } }, { paymentMethod: 'safepay', orderStatus: 'cancelled',
    awaitingPayment: true, 'paymentResult.failureCode': 'SAFEPAY_SAFETY_REFUND_PENDING' }]);
  expect(mockAttach).toHaveBeenCalledWith([]);
});
test('buyer detail denies another purchaser before refund evidence is attached', async () => {
  const res = response(); mockFindOne.mockResolvedValue({ _id: 'order-a', user: 'victim' });
  await getOrderDetail({ user: { id: 'buyer-a', role: 'seller' }, params: { id: 'order-a' }, query: { view: 'buyer' } }, res);
  expect(mockFindOne).toHaveBeenCalledWith({ _id: 'order-a', user: 'buyer-a' });
  expect(res.status).toHaveBeenCalledWith(403); expect(mockAttach).not.toHaveBeenCalled();
});
