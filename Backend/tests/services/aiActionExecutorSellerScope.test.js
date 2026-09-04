const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const User = require('../../models/User');
const Store = require('../../models/Store');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const { cancelOrderSafely } = require('../../services/orderCancellationService');
const { __private, executeToolCall } = require('../../services/aiActionExecutor');
const {
  buildOrderSellerCurrencyMoney,
  buildOrderSellerSettlement,
} = require('../../services/orderMoneyService');

const SELLER_A = '111111111111111111111111';
const SELLER_B = '222222222222222222222222';
const PRODUCT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const PRODUCT_C = 'cccccccccccccccccccccccc';

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterEach(async () => {
  await Promise.all([
    Order.deleteMany({}),
    Product.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
    SellerBalanceTransaction.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

const createOrder = (orderId, item, overrides = {}) => Order.create({
  orderId,
  orderItems: overrides.orderItems || [{
    productId: item.productId,
    seller: item.seller,
    name: item.name,
    image: 'https://example.com/product.jpg',
    price: 100,
    quantity: 1,
  }],
  shippingInfo: {
    fullName: 'Scope Buyer',
    email: 'scope-buyer@example.com',
    phone: '+14155552671',
    address: '1 Test Street',
    city: 'Test City',
    state: 'Test State',
    postalCode: '10000',
    country: 'United States',
  },
  shippingMethod: { name: 'Standard', price: 0, estimatedDays: 5 },
  orderSummary: { subtotal: 100, shippingCost: 0, totalAmount: 100 },
  paymentMethod: 'cash_on_delivery',
  ...overrides,
});

const createCurrentProduct = seller => Product.create({
  _id: PRODUCT_A,
  seller,
  name: 'Reassigned product',
  description: 'A product whose ownership changed after checkout.',
  price: 100,
  category: 'Test',
  brand: 'Test Brand',
  stock: 5,
  image: 'https://example.com/reassigned.jpg',
  images: [{ url: 'https://example.com/reassigned.jpg' }],
});

describe('aiActionExecutor seller order attribution', () => {
  test('AI admin deletion removes marketplace data and retains order snapshots', async () => {
    const seller = await User.create({
      username: 'ai-delete-seller',
      email: 'ai-delete-seller@test.com',
      password: 'password123',
      role: 'seller',
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'AI Delete Store',
      storeSlug: 'ai-delete-store',
      isActive: true,
    });
    const product = await Product.create({
      seller: seller._id,
      name: 'AI Delete Product',
      price: 50,
      category: 'Test',
      brand: 'Test',
      stock: 3,
      image: 'https://example.com/ai-delete.jpg',
    });
    const evidenceId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({
      _id: evidenceId,
      orderId: 'AI-DELETE-EVIDENCE',
      orderItems: [{
        productId: product._id,
        seller: seller._id,
        name: product.name,
        price: product.price,
        quantity: 1,
      }],
      sellerPolicies: [{ seller: seller._id, store: store._id, storeName: store.storeName }],
      paymentResult: { paymentIntentId: 'pi_ai_delete_evidence' },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ledger = await SellerBalanceTransaction.create({
      seller: seller._id,
      type: 'admin_adjustment',
      direction: 'credit',
      status: 'completed',
      amountUSD: 12,
      sourceAmount: 12,
      sourceCurrency: 'USD',
      referenceType: 'admin',
      referenceId: 'ai-delete-preserved-ledger',
      description: 'AI deletion historical ledger evidence',
    });

    const result = await executeToolCall('delete_user', {
      userId: seller._id.toString(),
    }, { _id: new mongoose.Types.ObjectId(), role: 'admin' });

    expect(result.success).toBe(true);
    await expect(User.exists({ _id: seller._id })).resolves.toBeNull();
    await expect(Store.exists({ _id: store._id })).resolves.toBeNull();
    await expect(Product.exists({ _id: product._id })).resolves.toBeNull();
    await expect(Order.exists({ _id: evidenceId })).resolves.not.toBeNull();
    await expect(SellerBalanceTransaction.exists({ _id: ledger._id })).resolves.not.toBeNull();
    const evidence = await Order.collection.findOne({ _id: evidenceId });
    expect(evidence.paymentResult.paymentIntentId).toBe('pi_ai_delete_evidence');
    expect(evidence.orderItems[0].name).toBe('AI Delete Product');
  });

  test('treats an item seller snapshot as authoritative after product ownership changes', () => {
    const reassignedItem = {
      seller: new mongoose.Types.ObjectId(SELLER_A),
      productId: new mongoose.Types.ObjectId(PRODUCT_A),
    };

    expect(__private.sellerOwnsOrderItem(
      reassignedItem,
      new mongoose.Types.ObjectId(SELLER_A),
      []
    )).toBe(true);
    expect(__private.sellerOwnsOrderItem(
      reassignedItem,
      new mongoose.Types.ObjectId(SELLER_B),
      [new mongoose.Types.ObjectId(PRODUCT_A)]
    )).toBe(false);
  });

  test('falls back to current product ownership only for legacy items without a seller snapshot', () => {
    expect(__private.sellerOwnsOrderItem(
      { seller: null, productId: PRODUCT_A },
      SELLER_B,
      [PRODUCT_A]
    )).toBe(true);
    expect(__private.sellerOwnsOrderItem(
      { productId: PRODUCT_A },
      SELLER_B,
      [PRODUCT_A]
    )).toBe(true);
    expect(__private.sellerOwnsOrderItem(
      { seller: SELLER_A, productId: PRODUCT_A },
      SELLER_B,
      [PRODUCT_A]
    )).toBe(false);
  });

  test('filters mixed orders without leaking explicitly other-seller items', () => {
    const order = {
      orderItems: [
        { name: 'snapshot-owned', seller: SELLER_B, productId: PRODUCT_A },
        { name: 'reassigned-away', seller: SELLER_A, productId: PRODUCT_B },
        { name: 'legacy-current', seller: null, productId: PRODUCT_C },
        { name: 'unowned-legacy', productId: PRODUCT_A },
      ],
    };

    const items = __private.filterSellerOrderItems(order, SELLER_B, [PRODUCT_B, PRODUCT_C]);

    expect(items.map(item => item.name)).toEqual(['snapshot-owned', 'legacy-current']);
  });

  test('builds a snapshot-or-legacy query with the fallback confined to null sellers', () => {
    expect(__private.buildSellerOrderScope(SELLER_B, [PRODUCT_A])).toEqual({
      $or: [
        { orderItems: { $elemMatch: { seller: SELLER_B } } },
        {
          orderItems: {
            $elemMatch: {
              seller: null,
              productId: { $in: [PRODUCT_A] },
            },
          },
        },
      ],
    });
  });

  test('keeps snapshot order lookup available when a seller has no current products', () => {
    expect(__private.buildSellerOrderScope(SELLER_A, [])).toEqual({
      orderItems: { $elemMatch: { seller: SELLER_A } },
    });
  });

  test('Mongo query fallback excludes an explicit other-seller snapshot', async () => {
    await Promise.all([
      createOrder('SNAPSHOT-OTHER', {
        name: 'explicit original owner',
        seller: SELLER_A,
        productId: PRODUCT_A,
      }),
      createOrder('LEGACY-CURRENT', {
        name: 'legacy current owner',
        seller: null,
        productId: PRODUCT_A,
      }),
    ]);

    const sellerBOrders = await Order.find(
      __private.buildSellerOrderScope(SELLER_B, [PRODUCT_A])
    ).select('orderId').lean();
    const sellerAOrders = await Order.find(
      __private.buildSellerOrderScope(SELLER_A, [])
    ).select('orderId').lean();

    expect(sellerBOrders.map(order => order.orderId)).toEqual(['LEGACY-CURRENT']);
    expect(sellerAOrders.map(order => order.orderId)).toEqual(['SNAPSHOT-OTHER']);
  });

  test('seller AI cannot read, total, or update a reassigned historical line', async () => {
    await createCurrentProduct(SELLER_B);
    const order = await createOrder('REASSIGNED-HISTORY', {
      name: 'original seller line',
      seller: SELLER_A,
      productId: PRODUCT_A,
    });
    const seller = { id: SELLER_B, role: 'seller', currency: 'USD' };

    const orderList = await executeToolCall('get_seller_orders', {}, seller);
    const detail = await executeToolCall('get_order_detail', { orderId: order._id.toString() }, seller);
    const analytics = await executeToolCall('get_seller_analytics', {}, seller);
    const update = await executeToolCall('update_order_status', {
      orderId: order._id.toString(),
      newStatus: 'processing',
    }, seller);

    expect(orderList).toMatchObject({ success: true, data: { orders: [], totalCount: 0 } });
    expect(detail).toMatchObject({ success: false, error: 'Order not found or access denied.' });
    expect(analytics).toMatchObject({ success: true, data: { totalOrders: 0, totalRevenue: 0 } });
    expect(update).toMatchObject({
      success: false,
      error: 'This order doesn\'t contain your products.',
    });
    await expect(Order.findById(order._id).select('orderStatus').lean())
      .resolves.toMatchObject({ orderStatus: 'pending' });
  });

  test('seller AI hides abandoned payment orders from lists, details, and updates', async () => {
    await createCurrentProduct(SELLER_B);
    const order = await createOrder('AWAITING-PAYMENT', {
      name: 'seller item',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, { awaitingPayment: true });
    const seller = { id: SELLER_B, role: 'seller', currency: 'USD' };

    const sellerOrders = await executeToolCall('get_seller_orders', {}, seller);
    const sharedOrders = await executeToolCall('get_my_orders', {}, seller);
    const detail = await executeToolCall('get_order_detail', { orderId: order._id.toString() }, seller);
    const update = await executeToolCall('update_order_status', {
      orderId: order._id.toString(),
      newStatus: 'processing',
    }, seller);

    expect(sellerOrders).toMatchObject({ success: true, data: { orders: [], totalCount: 0 } });
    expect(sharedOrders).toMatchObject({ success: true, data: { orders: [], totalCount: 0 } });
    expect(detail).toMatchObject({ success: false, error: 'Order not found or access denied.' });
    expect(update).toMatchObject({
      success: false,
      error: 'This order doesn\'t contain your products.',
    });
  });

  test('seller status filters and updates use only that seller fulfillment', async () => {
    const order = await createOrder('MULTI-SELLER-STATUS', {
      name: 'unused',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      orderItems: [
        {
          productId: PRODUCT_A,
          seller: SELLER_B,
          name: 'seller B item',
          image: 'https://example.com/b.jpg',
          price: 100,
          quantity: 1,
        },
        {
          productId: PRODUCT_C,
          seller: SELLER_A,
          name: 'seller A item',
          image: 'https://example.com/a.jpg',
          price: 50,
          quantity: 1,
        },
      ],
      sellerFulfillment: [
        { seller: SELLER_B, status: 'processing' },
        { seller: SELLER_A, status: 'pending' },
      ],
      orderSummary: { subtotal: 150, shippingCost: 0, totalAmount: 150 },
      orderStatus: 'pending',
      inventoryCommitted: true,
    });
    const seller = { id: SELLER_B, role: 'seller', currency: 'USD' };

    const matching = await executeToolCall('get_seller_orders', { status: 'processing' }, seller);
    const notMatching = await executeToolCall('get_seller_orders', { status: 'pending' }, seller);
    const sharedMatching = await executeToolCall('get_my_orders', { status: 'processing' }, seller);
    const detail = await executeToolCall('get_order_detail', { orderId: order._id.toString() }, seller);
    const update = await executeToolCall('update_order_status', {
      orderId: order._id.toString(),
      newStatus: 'delivered',
    }, seller);
    const persisted = await Order.findById(order._id).lean();
    const fulfillmentBySeller = Object.fromEntries(
      persisted.sellerFulfillment.map(entry => [entry.seller.toString(), entry.status])
    );

    expect(matching).toMatchObject({
      success: true,
      data: { orders: [{ status: 'processing', total: 100, itemCount: 1 }], totalCount: 1 },
    });
    expect(notMatching).toMatchObject({ success: true, data: { orders: [], totalCount: 0 } });
    expect(sharedMatching).toMatchObject({
      success: true,
      data: { orders: [{ status: 'processing', total: 100 }], totalCount: 1 },
    });
    expect(detail).toMatchObject({ success: true, data: { status: 'processing' } });
    expect(update).toMatchObject({
      success: true,
      data: { status: 'delivered', aggregateOrderStatus: 'pending' },
    });
    expect(fulfillmentBySeller).toMatchObject({
      [SELLER_B]: 'delivered',
      [SELLER_A]: 'pending',
    });
    expect(persisted.orderStatus).toBe('pending');
    expect(persisted.isPaid).toBe(false);
  });

  test('seller AI reports the exact allocated shipping, tax, discount, and total', async () => {
    const order = await createOrder('MULTI-SELLER-MONEY', {
      name: 'unused',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      orderItems: [
        {
          productId: PRODUCT_A,
          seller: SELLER_B,
          name: 'seller B item',
          image: 'https://example.com/b.jpg',
          price: 100,
          quantity: 1,
        },
        {
          productId: PRODUCT_C,
          seller: SELLER_A,
          name: 'seller A item',
          image: 'https://example.com/a.jpg',
          price: 50,
          quantity: 1,
        },
      ],
      sellerShipping: [
        { seller: SELLER_B, shippingMethod: { name: 'B shipping', price: 20, estimatedDays: 3 } },
        { seller: SELLER_A, shippingMethod: { name: 'A shipping', price: 10, estimatedDays: 4 } },
      ],
      orderSummary: {
        subtotal: 150,
        shippingCost: 30,
        tax: 15,
        couponDiscount: 15,
        totalAmount: 180,
      },
    });
    const seller = { id: SELLER_B, role: 'seller', currency: 'USD' };

    const sellerOrders = await executeToolCall('get_seller_orders', {}, seller);
    const sharedOrders = await executeToolCall('get_my_orders', {}, seller);
    const detail = await executeToolCall('get_order_detail', { orderId: order._id.toString() }, seller);

    const exactMoney = {
      subtotal: 100,
      shipping: 20,
      tax: 10,
      discount: 10,
      total: 120,
    };
    expect(sellerOrders).toMatchObject({
      success: true,
      data: { orders: [{ total: 120, money: exactMoney }] },
    });
    expect(sharedOrders).toMatchObject({
      success: true,
      data: { orders: [{ total: 120, money: exactMoney }] },
    });
    expect(detail).toMatchObject({
      success: true,
      data: { summary: exactMoney },
    });
  });

  test('seller AI leads with frozen store currency and keeps buyer checkout money as context', async () => {
    const rates = { USD: 1, PKR: 277.86, EUR: 0.92, GBP: 0.79 };
    const frozenOrder = {
      currency: 'USD',
      exchangeRateSnapshot: {
        base: 'USD',
        rates,
        capturedAt: new Date('2026-08-30T00:00:00.000Z'),
        source: 'test',
        fallback: false,
      },
      orderItems: [{
        productId: PRODUCT_A,
        seller: SELLER_B,
        name: 'PKR seller item',
        image: 'https://example.com/pkr-item.jpg',
        price: 7.16,
        lineSubtotal: 7.16,
        sourcePrice: 1990,
        sourceCurrency: 'PKR',
        sourceLineSubtotal: 1990,
        priceOriginal: 1990,
        priceCurrency: 'PKR',
        quantity: 1,
        selectedColor: 'Walnut',
        selectedOptions: { Finish: 'Matte' },
      }],
      sellerShipping: [{
        seller: SELLER_B,
        shippingMethod: {
          name: 'Free',
          price: 0,
          estimatedDays: 3,
          sourceCost: 0,
          sourceCurrency: 'PKR',
        },
      }],
      sellerPolicies: [{ seller: SELLER_B, productCurrency: 'PKR' }],
      orderSummary: {
        subtotal: 7.16,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 7.16,
      },
    };
    frozenOrder.sellerSettlementVersion = 1;
    frozenOrder.sellerSettlement = buildOrderSellerSettlement(frozenOrder, { requireOrderTotal: true });
    frozenOrder.sellerCurrencyMoneyVersion = 1;
    frozenOrder.sellerCurrencyMoney = buildOrderSellerCurrencyMoney(frozenOrder);

    const order = await createOrder('SELLER-NATIVE-AI', frozenOrder.orderItems[0], frozenOrder);
    const seller = { id: SELLER_B, role: 'seller', currency: 'USD' };

    const sellerOrders = await executeToolCall('get_seller_orders', {}, seller);
    const sharedOrders = await executeToolCall('get_my_orders', {}, seller);
    const detail = await executeToolCall('get_order_detail', { orderId: order._id.toString() }, seller);

    const expectedNative = {
      currency: 'PKR',
      total: 1989.48,
      money: {
        subtotal: 1990,
        shipping: 0,
        tax: 0,
        discount: 0,
        adjustment: -0.52,
        total: 1989.48,
      },
      buyerEquivalent: {
        currency: 'USD',
        subtotal: 7.16,
        shipping: 0,
        tax: 0,
        discount: 0,
        adjustment: 0,
        total: 7.16,
      },
    };
    expect(sellerOrders).toMatchObject({ success: true, data: { orders: [expectedNative] } });
    expect(sharedOrders).toMatchObject({
      success: true,
      data: {
        orders: [{
          ...expectedNative,
          items: [{
            name: 'PKR seller item',
            price: 1990,
            lineSubtotal: 1990,
            currency: 'PKR',
            buyerPrice: 7.16,
            buyerLineSubtotal: 7.16,
            buyerCurrency: 'USD',
            selectedColor: 'Walnut',
            selectedOptions: { Finish: 'Matte' },
          }],
        }],
      },
    });
    expect(detail).toMatchObject({
      success: true,
      data: {
        currency: 'PKR',
        buyerCurrency: 'USD',
        summary: expectedNative.money,
        buyerSummary: expectedNative.buyerEquivalent,
        items: [{
          name: 'PKR seller item',
          lineSubtotal: 1990,
          selectedColor: 'Walnut',
          selectedOptions: { Finish: 'Matte' },
        }],
      },
    });
  });

  test('seller AI cannot cancel a paid seller fulfillment without a verified refund', async () => {
    const order = await createOrder('PAID-SELLER-PORTION', {
      name: 'paid seller item',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      isPaid: true,
      sellerFulfillment: [{ seller: SELLER_B, status: 'processing' }],
      orderStatus: 'processing',
    });

    const result = await executeToolCall('update_order_status', {
      orderId: order._id.toString(),
      newStatus: 'cancelled',
    }, { id: SELLER_B, role: 'seller', currency: 'USD' });
    const persisted = await Order.findById(order._id).lean();

    expect(result).toMatchObject({
      success: false,
      code: 'PAID_ORDER_REQUIRES_REFUND',
    });
    expect(persisted.sellerFulfillment[0].status).toBe('processing');
    expect(persisted.orderStatus).toBe('processing');
  });

  test('admin AI cannot manufacture payment by delivering an awaiting Stripe order', async () => {
    const order = await createOrder('AI-UNPAID-STRIPE', {
      name: 'unpaid Stripe item',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      paymentMethod: 'stripe',
      paymentFlow: 'payment_sheet',
      paymentSetupState: 'ready',
      stripePaymentIntentId: 'pi_ai_unpaid_status',
      awaitingPayment: true,
      isPaid: false,
      inventoryCommitted: true,
      sellerFulfillment: [{ seller: SELLER_B, status: 'pending' }],
    });

    const result = await executeToolCall('update_order_status', {
      orderId: order._id.toString(),
      newStatus: 'delivered',
    }, { id: 'admin-status-test', role: 'admin', currency: 'USD' });
    const persisted = await Order.findById(order._id).lean();

    expect(result).toMatchObject({
      success: false,
      code: 'ORDER_PAYMENT_NOT_CONFIRMED',
    });
    expect(persisted).toMatchObject({
      orderStatus: 'pending',
      isPaid: false,
      awaitingPayment: true,
      inventoryCommitted: true,
    });
  });

  test('AI delivery and safe cancellation cannot resurrect or partially cancel the same order', async () => {
    const order = await createOrder('AI-STATUS-CANCEL-RACE', {
      name: 'status cancellation race item',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      inventoryCommitted: false,
      sellerFulfillment: [{ seller: SELLER_B, status: 'pending' }],
    });

    const [aiResult, cancellationResult] = await Promise.allSettled([
      executeToolCall('update_order_status', {
        orderId: order._id.toString(),
        newStatus: 'delivered',
      }, { id: 'admin-race-test', role: 'admin', currency: 'USD' }),
      cancelOrderSafely({
        orderId: order._id,
        reason: 'AI status concurrency test.',
      }),
    ]);
    const persisted = await Order.findById(order._id).lean();
    const aiWon = aiResult.status === 'fulfilled' && aiResult.value.success === true;
    const cancellationWon = cancellationResult.status === 'fulfilled';

    expect([aiWon, cancellationWon].filter(Boolean)).toHaveLength(1);
    if (cancellationWon) {
      expect(persisted).toMatchObject({
        orderStatus: 'cancelled',
        isPaid: false,
        isDelivered: false,
        inventoryCommitted: false,
      });
      expect(persisted.sellerFulfillment[0].status).toBe('cancelled');
    } else {
      expect(persisted).toMatchObject({
        orderStatus: 'delivered',
        isPaid: true,
        isDelivered: true,
        inventoryCommitted: false,
      });
      expect(persisted.sellerFulfillment[0].status).toBe('delivered');
    }
  });

  test('seller AI analytics uses seller fulfillment and recognized online revenue', async () => {
    await createCurrentProduct(SELLER_B);
    await createOrder('UNPAID-SELLER-ANALYTICS', {
      name: 'unpaid seller item',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      isPaid: false,
      orderStatus: 'delivered',
      sellerFulfillment: [{ seller: SELLER_B, status: 'processing' }],
    });
    await createOrder('PAID-SELLER-ANALYTICS', {
      name: 'paid seller item',
      seller: SELLER_B,
      productId: PRODUCT_A,
    }, {
      paymentMethod: 'stripe',
      isPaid: true,
      orderStatus: 'delivered',
      sellerFulfillment: [{ seller: SELLER_B, status: 'pending' }],
    });

    const result = await executeToolCall('get_seller_analytics', {}, {
      id: SELLER_B,
      role: 'seller',
      currency: 'USD',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        totalOrders: 2,
        totalRevenue: 100,
        ordersByStatus: { processing: 1, pending: 1 },
        topProducts: [{ name: 'paid seller item', sold: 1 }],
      },
    });
    expect(result.data.ordersByStatus.delivered).toBeUndefined();
  });

  test('admin AI analytics excludes hidden/unpaid revenue and allocates partial COD exactly', async () => {
    const item = (productId, seller, price) => ({
      productId,
      seller,
      name: `Item ${productId}`,
      image: 'https://example.com/item.jpg',
      price,
      quantity: 1,
    });

    await createOrder('ADMIN-PAID-CENTS', {
      name: 'unused', seller: SELLER_A, productId: PRODUCT_A,
    }, {
      orderItems: [item(PRODUCT_A, SELLER_A, 0.01), item(PRODUCT_B, SELLER_B, 0.01)],
      orderSummary: { subtotal: 0.02, shippingCost: 0, tax: 0.01, totalAmount: 0.03 },
      paymentMethod: 'stripe',
      isPaid: true,
      orderStatus: 'processing',
    });
    await createOrder('ADMIN-PARTIAL-COD', {
      name: 'unused', seller: SELLER_A, productId: PRODUCT_A,
    }, {
      orderItems: [item(PRODUCT_A, SELLER_A, 0.05), item(PRODUCT_B, SELLER_B, 0.07)],
      orderSummary: { subtotal: 0.12, shippingCost: 0, tax: 0, totalAmount: 0.12 },
      paymentMethod: 'cash_on_delivery',
      isPaid: false,
      orderStatus: 'processing',
      sellerFulfillment: [
        { seller: SELLER_A, status: 'delivered' },
        { seller: SELLER_B, status: 'processing' },
      ],
    });
    await createOrder('ADMIN-UNPAID-ONLINE', {
      name: 'unpaid', seller: SELLER_A, productId: PRODUCT_A,
    }, { paymentMethod: 'stripe', isPaid: false, orderStatus: 'processing' });
    await createOrder('ADMIN-HIDDEN-PAID', {
      name: 'hidden', seller: SELLER_A, productId: PRODUCT_A,
    }, { paymentMethod: 'stripe', isPaid: true, awaitingPayment: true, orderStatus: 'pending' });
    await createOrder('ADMIN-CANCELLED-PAID', {
      name: 'cancelled', seller: SELLER_A, productId: PRODUCT_A,
    }, { paymentMethod: 'stripe', isPaid: true, orderStatus: 'cancelled' });

    const result = await executeToolCall('get_admin_analytics', {}, {
      id: '999999999999999999999999',
      role: 'admin',
      currency: 'USD',
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        orders: { total: 4 },
        revenue: 0.08,
        currency: 'USD',
      },
    });
  });
});
