'use strict';

const mockCountDocuments = jest.fn();
const mockLean = jest.fn();
const mockLimit = jest.fn(() => ({ lean: mockLean }));
const mockSkip = jest.fn(() => ({ limit: mockLimit }));
const mockSort = jest.fn(() => ({ skip: mockSkip }));
const mockPopulateStore = jest.fn(() => ({ sort: mockSort }));
const mockPopulateSeller = jest.fn(() => ({ populate: mockPopulateStore }));
const mockFind = jest.fn(() => ({ populate: mockPopulateSeller }));

jest.mock('../../models/Order', () => ({}));
jest.mock('../../models/ReturnRequest', () => ({
  countDocuments: mockCountDocuments,
  find: mockFind,
}));
jest.mock('../../services/returnService', () => ({
  buildOrderReturnEligibility: jest.fn(),
  createReturnRequest: jest.fn(),
  getReturnDetail: jest.fn(),
  updateReturnStatus: jest.fn(),
  cancelReturnRequest: jest.fn(),
  settleFromSellerBalance: jest.fn(),
  approveReplacement: jest.fn(),
  createReturnSettlementCheckout: jest.fn(),
}));
jest.mock('../../services/returnNotificationService', () => ({
  notifyBuyerReturnStatus: jest.fn(),
  notifyReturnSettlementCompleted: jest.fn(),
}));

const { listMyReturns } = require('../../controllers/returnController');

const BUYER_ID = '64b000000000000000000001';
const ORDER_ID = '64b000000000000000000002';
const response = () => {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn(code => { res.statusCode = code; return res; }),
    json: jest.fn(body => { res.body = body; return res; }),
  };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCountDocuments.mockResolvedValue(101);
  mockLean.mockResolvedValue([{ _id: 'return-101' }]);
});
test('buyer return list exposes exact deterministic continuation metadata', async () => {
  const res = response();
  await listMyReturns({
    user: { id: BUYER_ID, role: 'user' },
    query: { orderId: ORDER_ID, page: '2', limit: '100' },
  }, res);

  expect(mockCountDocuments).toHaveBeenCalledWith({ buyer: BUYER_ID, order: ORDER_ID });
  expect(mockFind).toHaveBeenCalledWith({ buyer: BUYER_ID, order: ORDER_ID });
  expect(mockSort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
  expect(mockSkip).toHaveBeenCalledWith(100);
  expect(mockLimit).toHaveBeenCalledWith(100);
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({
    success: true,
    returns: [{ _id: 'return-101' }],
    pagination: {
      page: 2,
      limit: 100,
      totalReturns: 101,
      totalPages: 2,
      hasMore: false,
    },
  });
});

test.each([
  [{ orderId: 'not-an-object-id' }, 'RETURN_ORDER_INVALID'],
  [{ orderId: ORDER_ID, page: '0' }, 'RETURN_PAGINATION_INVALID'],
  [{ orderId: ORDER_ID, page: '1.5' }, 'RETURN_PAGINATION_INVALID'],
  [{ orderId: ORDER_ID, limit: '101' }, 'RETURN_PAGINATION_INVALID'],
  [{ orderId: ORDER_ID, limit: '1e2' }, 'RETURN_PAGINATION_INVALID'],
])('buyer return list rejects malformed query %p', async (query, code) => {
  const res = response();
  await listMyReturns({ user: { id: BUYER_ID, role: 'user' }, query }, res);
  expect(res.statusCode).toBe(400);
  expect(res.body).toEqual(expect.objectContaining({ code }));
  expect(mockFind).not.toHaveBeenCalled();
});
