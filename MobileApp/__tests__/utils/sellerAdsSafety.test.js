import {
  formatSellerAdsUsdCents,
  inspectSellerAdsMutationResponse,
  inspectSellerAdsOverview,
  isCanonicalSellerAdsObjectId,
  selectSellerAdsOverviewOwnership,
  selectSellerAdsProductMoney,
  sellerAdsOverviewReflectsMutation,
} from '../../src/utils/sellerAdsSafety';

const IDS = Object.freeze({
  seller: '64b000000000000000000001',
  otherSeller: '64b000000000000000000002',
  store: '64b000000000000000000003',
  otherStore: '64b000000000000000000009',
  product: '64b000000000000000000004',
  secondProduct: '64b000000000000000000005',
  request: '64b000000000000000000006',
  secondRequest: '64b000000000000000000007',
  reviewer: '64b000000000000000000008',
});

const makeProduct = (overrides = {}) => ({
  _id: IDS.product,
  seller: IDS.seller,
  name: 'Native-priced product',
  category: 'Accessories',
  image: 'https://cdn.test/product.jpg',
  images: [{ url: 'https://cdn.test/product.jpg' }],
  price: 200,
  discountedPrice: 0,
  currency: 'PKR',
  priceCurrency: 'PKR',
  isFeatured: true,
  ...overrides,
});

const makeRequest = (overrides = {}) => {
  const product = makeProduct();
  return {
    _id: IDS.request,
    seller: IDS.seller,
    store: IDS.store,
    products: [product],
    productIds: [product._id],
    requestType: 'start',
    status: 'pending',
    active: false,
    channels: { tiktok: true, meta: false },
    sellerNote: '',
    adminNote: '',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
};

const makeOverview = (overrides = {}) => {
  const pending = makeRequest();
  return {
    subscription: {
      plan: 'elite',
      status: 'active',
      planName: 'Rozare Elite',
      metaAdsIncluded: false,
    },
    isElite: true,
    metaAdsAddonCents: 400,
    store: {
      _id: IDS.store,
      seller: IDS.seller,
      storeName: 'Safe Store',
      storeSlug: 'safe-store',
      logo: '',
    },
    featuredProducts: [makeProduct()],
    activeRequest: null,
    pendingRequests: [pending],
    recentRequests: [pending],
    ...overrides,
  };
};

describe('seller ads presentation safety', () => {
  test('accepts one complete native-currency overview without converting product money', () => {
    const overview = makeOverview();
    expect(inspectSellerAdsOverview(overview)).toBe(overview);
    expect(selectSellerAdsProductMoney(overview.featuredProducts[0])).toEqual({
      amount: 200,
      currency: 'PKR',
    });
  });

  test('preserves a legitimate free price instead of treating zero as missing', () => {
    const freeProduct = makeProduct({ price: 0, discountedPrice: 0 });
    const freeRequest = makeRequest({ products: [freeProduct], productIds: [freeProduct._id] });
    expect(selectSellerAdsProductMoney(freeProduct)).toEqual({ amount: 0, currency: 'PKR' });
    expect(inspectSellerAdsOverview(makeOverview({
      featuredProducts: [freeProduct],
      pendingRequests: [freeRequest],
      recentRequests: [freeRequest],
    }))).not.toBeNull();
  });

  test.each(['USD', 'PKR', 'EUR', 'GBP'])('accepts canonical coherent %s aliases', (currency) => {
    const product = makeProduct({ currency, priceCurrency: currency });
    const pending = makeRequest({ products: [product], productIds: [product._id] });
    expect(inspectSellerAdsOverview(makeOverview({
      featuredProducts: [product],
      pendingRequests: [pending],
      recentRequests: [pending],
    }))).not.toBeNull();
  });

  test.each([
    { price: '200' },
    { price: true },
    { price: Number.NaN },
    { price: -1 },
    { price: 1.001 },
    { price: Number.MAX_SAFE_INTEGER },
    { discountedPrice: '0' },
    { price: 100, discountedPrice: 100 },
    { price: 100, discountedPrice: 120 },
  ])('rejects inexact or incoherent product money %#', (priceOverride) => {
    const product = makeProduct(priceOverride);
    expect(selectSellerAdsProductMoney(product)).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({ featuredProducts: [product] }))).toBeNull();
  });

  test.each([
    { currency: 'usd', priceCurrency: 'USD' },
    { currency: 'USD', priceCurrency: 'PKR' },
    { currency: 'CAD', priceCurrency: 'CAD' },
    { currency: null, priceCurrency: 'USD' },
  ])('rejects missing, noncanonical, unsupported, or conflicting currency aliases %#', (currencyOverride) => {
    const product = makeProduct(currencyOverride);
    expect(selectSellerAdsProductMoney(product)).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({ featuredProducts: [product] }))).toBeNull();
  });

  test.each([0, -1, 1.5, '400', true, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid USD Meta add-on minor units: %p',
    (metaAdsAddonCents) => {
      expect(inspectSellerAdsOverview(makeOverview({ metaAdsAddonCents }))).toBeNull();
      expect(() => formatSellerAdsUsdCents(metaAdsAddonCents)).toThrow();
    }
  );

  test('formats positive USD minor units exactly without a default value', () => {
    expect(formatSellerAdsUsdCents(1)).toBe('$0.01 USD');
    expect(formatSellerAdsUsdCents(400)).toBe('$4.00 USD');
    expect(formatSellerAdsUsdCents(Number.MAX_SAFE_INTEGER))
      .toBe('$90071992547409.91 USD');
  });

  test('requires canonical lowercase ObjectIds throughout the response', () => {
    expect(isCanonicalSellerAdsObjectId(IDS.product)).toBe(true);
    expect(isCanonicalSellerAdsObjectId(IDS.product.toUpperCase())).toBe(false);
    expect(isCanonicalSellerAdsObjectId({ _id: IDS.product })).toBe(false);
    expect(inspectSellerAdsOverview(makeOverview({
      featuredProducts: [makeProduct({ _id: 'product-1' })],
    }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      store: { ...makeOverview().store, seller: IDS.otherSeller },
    }))).toBeNull();
  });

  test('requires complete arrays with unique identities and one unambiguous pending request', () => {
    expect(inspectSellerAdsOverview(makeOverview({ featuredProducts: null }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({ recentRequests: {} }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      featuredProducts: [makeProduct(), makeProduct()],
    }))).toBeNull();

    const first = makeRequest();
    const second = makeRequest({
      _id: IDS.secondRequest,
      createdAt: '2026-08-25T11:00:00.000Z',
      updatedAt: '2026-08-25T11:00:00.000Z',
    });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [second, first],
      recentRequests: [second, first],
    }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [first],
      recentRequests: [],
    }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [],
      recentRequests: [first],
    }))).toBeNull();
  });

  test('reconciles every duplicate request snapshot across active, pending, and recent arrays', () => {
    const pending = makeRequest();
    const conflictingRecent = makeRequest({ channels: { tiktok: true, meta: true } });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [pending],
      recentRequests: [conflictingRecent],
    }))).toBeNull();

    const active = makeRequest({
      _id: IDS.secondRequest,
      status: 'approved',
      active: true,
      reviewedBy: IDS.reviewer,
      reviewedAt: '2026-08-25T10:05:00.000Z',
      updatedAt: '2026-08-25T10:05:00.000Z',
    });
    const staleActiveCopy = { ...active, active: false };
    expect(inspectSellerAdsOverview(makeOverview({
      activeRequest: active,
      pendingRequests: [],
      recentRequests: [staleActiveCopy],
    }))).toBeNull();
  });

  test('reconciles repeated product ownership, feature state, native money, and currency aliases', () => {
    const conflictingProduct = makeProduct({ price: 201 });
    const conflictingRequest = makeRequest({
      products: [conflictingProduct],
      productIds: [conflictingProduct._id],
    });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [conflictingRequest],
      recentRequests: [conflictingRequest],
    }))).toBeNull();

    const unfeaturedProduct = makeProduct({ isFeatured: false });
    const unfeaturedRequest = makeRequest({
      products: [unfeaturedProduct],
      productIds: [unfeaturedProduct._id],
    });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [unfeaturedRequest],
      recentRequests: [unfeaturedRequest],
    }))).toBeNull();
  });

  test('requires every request store reference to equal the top-level store', () => {
    const request = makeRequest({ store: IDS.otherStore });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [request],
      recentRequests: [request],
    }))).toBeNull();

    expect(inspectSellerAdsOverview(makeOverview({
      store: null,
      featuredProducts: [],
      pendingRequests: [],
      recentRequests: [],
    }))).not.toBeNull();
  });

  test('caps recent history at the endpoint limit of twelve', () => {
    const history = Array.from({ length: 13 }, (_, index) => makeRequest({
      _id: (index + 32).toString(16).padStart(24, '0'),
      status: 'rejected',
      reviewedBy: IDS.reviewer,
      reviewedAt: '2026-08-25T10:05:00.000Z',
      updatedAt: '2026-08-25T10:05:00.000Z',
    }));
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [],
      recentRequests: history,
    }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [],
      recentRequests: history.slice(0, 12),
    }))).not.toBeNull();
  });

  test('ties pending request types and recent active state to the authoritative active request', () => {
    const updateWithoutActive = makeRequest({ requestType: 'update' });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [updateWithoutActive],
      recentRequests: [updateWithoutActive],
    }))).toBeNull();

    const active = makeRequest({
      _id: IDS.secondRequest,
      status: 'approved',
      active: true,
      reviewedBy: IDS.reviewer,
      reviewedAt: '2026-08-25T10:05:00.000Z',
      updatedAt: '2026-08-25T10:05:00.000Z',
    });
    const startWithActive = makeRequest();
    expect(inspectSellerAdsOverview(makeOverview({
      activeRequest: active,
      pendingRequests: [startWithActive],
      recentRequests: [startWithActive, active],
    }))).toBeNull();

    const updateWithActive = makeRequest({ requestType: 'update' });
    expect(inspectSellerAdsOverview(makeOverview({
      activeRequest: active,
      pendingRequests: [updateWithActive],
      recentRequests: [updateWithActive, active],
    }))).not.toBeNull();

    const otherActive = {
      ...active,
      _id: '64b00000000000000000000a',
    };
    expect(inspectSellerAdsOverview(makeOverview({
      activeRequest: active,
      pendingRequests: [],
      recentRequests: [otherActive, active],
    }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      activeRequest: active,
      pendingRequests: [],
      recentRequests: [otherActive],
    }))).toBeNull();
  });

  test('enforces request-state, channel, review, and product-list coherence', () => {
    const approved = makeRequest({
      status: 'approved',
      active: true,
      reviewedBy: IDS.reviewer,
      reviewedAt: '2026-08-25T10:05:00.000Z',
      updatedAt: '2026-08-25T10:05:00.000Z',
    });
    expect(inspectSellerAdsOverview(makeOverview({
      activeRequest: approved,
      pendingRequests: [],
      recentRequests: [approved],
    }))).not.toBeNull();

    const historicalStop = makeRequest({
      requestType: 'stop',
      products: [],
      productIds: [],
      channels: { tiktok: true, meta: true },
      status: 'approved',
      active: false,
      reviewedBy: IDS.reviewer,
      reviewedAt: '2026-08-25T10:05:00.000Z',
      updatedAt: '2026-08-25T10:05:00.000Z',
    });
    expect(inspectSellerAdsOverview(makeOverview({
      pendingRequests: [],
      recentRequests: [historicalStop],
    }))).not.toBeNull();

    [
      makeRequest({ active: true }),
      makeRequest({ channels: { tiktok: false, meta: false } }),
      makeRequest({ adminNote: 'Review already started' }),
      makeRequest({ reviewedBy: IDS.reviewer }),
      makeRequest({ status: 'rejected', active: true }),
      makeRequest({ productIds: [IDS.secondProduct] }),
      makeRequest({ products: [] }),
    ].forEach((request) => {
      expect(inspectSellerAdsOverview(makeOverview({
        pendingRequests: [request],
        recentRequests: [request],
      }))).toBeNull();
    });
  });

  test('requires subscription entitlement fields to agree with isElite', () => {
    expect(inspectSellerAdsOverview(makeOverview({ isElite: false }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      subscription: { ...makeOverview().subscription, status: 'cancelled' },
      isElite: false,
    }))).not.toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      subscription: { ...makeOverview().subscription, metaAdsIncluded: 'yes' },
    }))).toBeNull();
    expect(inspectSellerAdsOverview(makeOverview({
      subscription: {
        ...makeOverview().subscription,
        plan: 'starter',
        status: 'active',
        planName: 'Rozare Starter',
        metaAdsIncluded: true,
      },
      isElite: false,
    }))).toBeNull();
    ['past_due', 'cancelled'].forEach((status) => {
      expect(inspectSellerAdsOverview(makeOverview({
        subscription: {
          ...makeOverview().subscription,
          plan: 'elite',
          status,
          metaAdsIncluded: true,
        },
        isElite: false,
      }))).not.toBeNull();
    });
  });
});

describe('seller ads mutation verification', () => {
  test('accepts only the exact pending request returned for the submitted payload', () => {
    const request = makeRequest();
    const payload = {
      msg: 'Ads request sent for admin approval.',
      request,
    };
    const expected = {
      requestType: 'start',
      productIds: [IDS.product],
      includeMeta: false,
      sellerNote: '',
      sellerId: IDS.seller,
      storeId: IDS.store,
    };

    expect(inspectSellerAdsMutationResponse(payload, expected)).toEqual({
      message: payload.msg,
      request,
    });
    expect(inspectSellerAdsMutationResponse({ ...payload, msg: '' }, expected)).toBeNull();
    expect(inspectSellerAdsMutationResponse(payload, { ...expected, includeMeta: true })).toBeNull();
    expect(inspectSellerAdsMutationResponse(payload, { ...expected, sellerNote: 'different' })).toBeNull();
    expect(inspectSellerAdsMutationResponse(payload, { ...expected, productIds: [IDS.secondProduct] }))
      .toBeNull();
    expect(inspectSellerAdsMutationResponse({
      ...payload,
      request: { ...request, status: 'approved' },
    }, expected)).toBeNull();
  });

  test('binds mutation responses to the seller and store captured from the verified overview', () => {
    expect(selectSellerAdsOverviewOwnership(makeOverview())).toEqual({
      sellerId: IDS.seller,
      storeId: IDS.store,
    });
    const expected = {
      requestType: 'start',
      productIds: [IDS.product],
      includeMeta: false,
      sellerNote: '',
      sellerId: IDS.seller,
      storeId: IDS.store,
    };
    const request = makeRequest();
    expect(inspectSellerAdsMutationResponse({
      msg: 'Accepted',
      request: { ...request, store: IDS.otherStore },
    }, expected)).toBeNull();

    const foreignProduct = makeProduct({ seller: IDS.otherSeller });
    const foreignRequest = makeRequest({
      seller: IDS.otherSeller,
      store: IDS.otherStore,
      products: [foreignProduct],
      productIds: [foreignProduct._id],
    });
    expect(inspectSellerAdsMutationResponse({
      msg: 'Accepted',
      request: foreignRequest,
    }, expected)).toBeNull();
  });

  test('requires the fresh verified overview to contain the exact mutation', () => {
    const request = makeRequest();
    const mutation = inspectSellerAdsMutationResponse({ msg: 'Accepted', request }, {
      requestType: 'start',
      productIds: [IDS.product],
      includeMeta: false,
    });
    expect(sellerAdsOverviewReflectsMutation(makeOverview(), mutation)).toBe(true);
    expect(sellerAdsOverviewReflectsMutation(makeOverview({ pendingRequests: [], recentRequests: [] }), mutation))
      .toBe(false);
    expect(sellerAdsOverviewReflectsMutation(makeOverview({
      pendingRequests: [makeRequest({ channels: { tiktok: true, meta: true } })],
      recentRequests: [makeRequest({ channels: { tiktok: true, meta: true } })],
    }), mutation)).toBe(false);

    const changedNote = makeRequest({ sellerNote: 'changed after mutation' });
    expect(sellerAdsOverviewReflectsMutation(makeOverview({
      pendingRequests: [changedNote],
      recentRequests: [changedNote],
    }), mutation)).toBe(false);

    const repricedProduct = makeProduct({ price: 201 });
    const repricedRequest = makeRequest({
      products: [repricedProduct],
      productIds: [repricedProduct._id],
    });
    expect(sellerAdsOverviewReflectsMutation(makeOverview({
      featuredProducts: [repricedProduct],
      pendingRequests: [repricedRequest],
      recentRequests: [repricedRequest],
    }), mutation)).toBe(false);
  });
});
