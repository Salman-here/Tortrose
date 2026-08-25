'use strict';

const mockSubscriptionFindOne = jest.fn();
const mockAdFindOne = jest.fn();
const mockAdCreate = jest.fn();
const mockAdFindById = jest.fn();
const mockProductFind = jest.fn();
const mockStoreFindOne = jest.fn();

jest.mock('../../models/SellerSubscription', () => ({
  findOne: mockSubscriptionFindOne,
}));
jest.mock('../../models/SellerAdRequest', () => ({
  findOne: mockAdFindOne,
  create: mockAdCreate,
  findById: mockAdFindById,
}));
jest.mock('../../models/Product', () => ({
  find: mockProductFind,
}));
jest.mock('../../models/Store', () => ({
  findOne: mockStoreFindOne,
}));
jest.mock('../../services/subscriptionPricingService', () => ({
  META_ADS_ADDON_CENTS: 1000,
}));

const { submitSellerAdRequest } = require('../../controllers/sellerAdController');

const PRODUCT_ID = '64b000000000000000000001';
const REQUEST_ID = '64b000000000000000000002';
const STORE_ID = '64b000000000000000000003';

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const request = body => ({
  user: { id: 'seller-1', role: 'seller' },
  body,
});

const queryResult = value => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

describe('seller ads request input boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['launch', '', null, true, ['start']])(
    'rejects an explicitly invalid request type %p instead of silently starting a campaign request',
    async (requestType) => {
      const res = response();
      await submitSellerAdRequest(request({ requestType, productIds: [PRODUCT_ID] }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ msg: 'Request type must be start, update, or stop.' });
      expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
      expect(mockAdCreate).not.toHaveBeenCalled();
    },
  );

  test.each(['false', 'true', 0, 1, null, []])(
    'rejects a non-boolean Include Meta value %p instead of coercing it',
    async (includeMeta) => {
      const res = response();
      await submitSellerAdRequest(request({ includeMeta, productIds: [PRODUCT_ID] }), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ msg: 'Include Meta must be true or false.' });
      expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
      expect(mockAdCreate).not.toHaveBeenCalled();
    },
  );

  test.each([
    { productIds: PRODUCT_ID },
    { productIds: [PRODUCT_ID, 'not-an-id'] },
    { productIds: [PRODUCT_ID, true] },
    { productIds: [] },
    {},
  ])('rejects a malformed or empty paid-campaign product selection %#', async (body) => {
    const res = response();
    await submitSellerAdRequest(request(body), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockSubscriptionFindOne).not.toHaveBeenCalled();
    expect(mockAdCreate).not.toHaveBeenCalled();
  });

  test('accepts omitted optional flags as an exact TikTok-only start request', async () => {
    mockSubscriptionFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        plan: 'elite',
        status: 'active',
        metaAdsIncluded: true,
      }),
    });
    mockAdFindOne.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });
    mockStoreFindOne.mockReturnValue({
      select: jest.fn().mockResolvedValue({ _id: STORE_ID }),
    });
    mockProductFind.mockReturnValue(queryResult([{ _id: PRODUCT_ID }]));
    mockAdCreate.mockResolvedValue({ _id: REQUEST_ID });
    mockAdFindById.mockReturnValue({
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: REQUEST_ID,
        products: [{ _id: PRODUCT_ID }],
        requestType: 'start',
        channels: { tiktok: true, meta: false },
      }),
    });

    const res = response();
    await submitSellerAdRequest(request({ productIds: [PRODUCT_ID.toUpperCase()] }), res);

    expect(mockAdCreate).toHaveBeenCalledWith(expect.objectContaining({
      products: [PRODUCT_ID],
      requestType: 'start',
      channels: { tiktok: true, meta: false },
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
