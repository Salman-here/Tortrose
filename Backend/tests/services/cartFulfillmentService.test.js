const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Cart = require('../../models/Cart');
const Order = require('../../models/Order');
const User = require('../../models/User');
const Product = require('../../models/Product');
const {
  canonicalOptions,
  removeFulfilledOrderItemsFromCart,
} = require('../../services/cartFulfillmentService');

let mongoServer;

const createUser = (suffix, role = 'user') => User.create({
  username: `cart-fulfillment-${suffix}`,
  email: `cart-fulfillment-${suffix}@test.com`,
  password: 'password123',
  role,
  currency: 'PKR',
});

const createProduct = (seller, suffix) => Product.create({
  name: `Fulfillment Product ${suffix}`,
  description: `Cart fulfillment product ${suffix}.`,
  price: 500,
  currency: 'PKR',
  priceCurrency: 'PKR',
  category: 'Test',
  brand: 'Rozare',
  stock: 20,
  image: `https://example.com/${suffix}.jpg`,
  images: [{ url: `https://example.com/${suffix}.jpg` }],
  seller: seller._id,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterEach(async () => {
  await Promise.all([
    Cart.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('fulfilled order cart cleanup', () => {
  test('canonicalizes selected option keys independent of insertion order', () => {
    expect(canonicalOptions({ Size: 'L', Material: 'Cotton' }))
      .toBe(canonicalOptions({ Material: 'Cotton', Size: 'L' }));
  });

  test('subtracts only ordered quantities and preserves later additions, variants, and unrelated items', async () => {
    const buyer = await createUser('buyer');
    const seller = await createUser('seller', 'seller');
    const [shirt, shoes] = await Promise.all([
      createProduct(seller, 'shirt'),
      createProduct(seller, 'shoes'),
    ]);
    await Cart.create({
      user: buyer._id,
      cartItems: [
        {
          product: shirt._id,
          qty: 5,
          selectedColor: 'Black',
          selectedOptions: { Material: 'Cotton', Size: 'L' },
        },
        {
          product: shirt._id,
          qty: 4,
          selectedColor: 'Blue',
          selectedOptions: { Size: 'L', Material: 'Cotton' },
        },
        { product: shoes._id, qty: 2 },
      ],
    });

    const fulfillmentId = new mongoose.Types.ObjectId();
    const result = await removeFulfilledOrderItemsFromCart({
      userId: buyer._id,
      fulfillmentId,
      orderItems: [{
        productId: shirt._id,
        quantity: 2,
        selectedColor: 'Black',
        selectedOptions: { Size: 'L', Material: 'Cotton' },
      }],
    });

    expect(result).toEqual({ matchedLines: 1, removedQuantity: 2 });
    const cart = await Cart.findOne({ user: buyer._id }).lean();
    expect(cart.cartItems).toHaveLength(3);
    expect(cart.cartItems.find(item => String(item.product) === String(shirt._id) && item.selectedColor === 'Black').qty).toBe(3);
    expect(cart.cartItems.find(item => String(item.product) === String(shirt._id) && item.selectedColor === 'Blue').qty).toBe(4);
    expect(cart.cartItems.find(item => String(item.product) === String(shoes._id)).qty).toBe(2);
  });

  test('removes only a fully consumed matching line', async () => {
    const buyer = await createUser('remove-buyer');
    const seller = await createUser('remove-seller', 'seller');
    const [ordered, unrelated] = await Promise.all([
      createProduct(seller, 'ordered'),
      createProduct(seller, 'unrelated'),
    ]);
    await Cart.create({
      user: buyer._id,
      cartItems: [
        { product: ordered._id, qty: 1 },
        { product: unrelated._id, qty: 2 },
      ],
    });

    await removeFulfilledOrderItemsFromCart({
      userId: buyer._id,
      fulfillmentId: new mongoose.Types.ObjectId(),
      orderItems: [{ productId: ordered._id, quantity: 1 }],
    });

    const cart = await Cart.findOne({ user: buyer._id }).lean();
    expect(cart.cartItems).toHaveLength(1);
    expect(String(cart.cartItems[0].product)).toBe(String(unrelated._id));
    expect(cart.cartItems[0].qty).toBe(2);
  });

  test('replaying the same fulfillment cannot subtract the order twice', async () => {
    const buyer = await createUser('idempotent-buyer');
    const seller = await createUser('idempotent-seller', 'seller');
    const product = await createProduct(seller, 'idempotent-product');
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 5 }],
    });

    const fulfillmentId = new mongoose.Types.ObjectId();
    const cleanup = {
      userId: buyer._id,
      fulfillmentId,
      orderItems: [{ productId: product._id, quantity: 2 }],
    };
    const first = await removeFulfilledOrderItemsFromCart(cleanup);
    const replay = await removeFulfilledOrderItemsFromCart(cleanup);

    expect(first).toEqual({ matchedLines: 1, removedQuantity: 2 });
    expect(replay).toEqual({ matchedLines: 0, removedQuantity: 0 });
    const cart = await Cart.findOne({ user: buyer._id }).select('+fulfilledOrderIds').lean();
    expect(cart.cartItems[0].qty).toBe(3);
    expect(cart.fulfilledOrderIds.map(String)).toEqual([String(fulfillmentId)]);
  });

  test('the durable order receipt protects a replacement cart from a later replay', async () => {
    const buyer = await createUser('replacement-buyer');
    const seller = await createUser('replacement-seller', 'seller');
    const product = await createProduct(seller, 'replacement-product');
    const fulfillmentId = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({
      _id: fulfillmentId,
      cartCleanupCompletedAt: null,
    });
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 5 }],
    });
    const cleanup = {
      userId: buyer._id,
      fulfillmentId,
      orderItems: [{ productId: product._id, quantity: 2 }],
    };

    await removeFulfilledOrderItemsFromCart(cleanup);
    await Cart.deleteOne({ user: buyer._id });
    await Cart.create({
      user: buyer._id,
      // These are newly-added units after the original cart was consumed.
      cartItems: [{ product: product._id, qty: 2 }],
    });

    const replay = await removeFulfilledOrderItemsFromCart(cleanup);
    expect(replay).toEqual({ matchedLines: 0, removedQuantity: 0 });
    expect((await Cart.findOne({ user: buyer._id }).lean()).cartItems[0].qty).toBe(2);
  });

  test('concurrent cleanup attempts have exactly one effect', async () => {
    const buyer = await createUser('concurrent-buyer');
    const seller = await createUser('concurrent-seller', 'seller');
    const product = await createProduct(seller, 'concurrent-product');
    const fulfillmentId = new mongoose.Types.ObjectId();
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 6 }],
    });

    const cleanup = {
      userId: buyer._id,
      fulfillmentId,
      orderItems: [{ productId: product._id, quantity: 2 }],
    };
    const results = await Promise.all([
      removeFulfilledOrderItemsFromCart(cleanup),
      removeFulfilledOrderItemsFromCart(cleanup),
    ]);

    expect(results.map(result => result.removedQuantity).sort()).toEqual([0, 2]);
    const cart = await Cart.findOne({ user: buyer._id }).select('+fulfilledOrderIds').lean();
    expect(cart.cartItems[0].qty).toBe(4);
    expect(cart.fulfilledOrderIds.map(String)).toEqual([String(fulfillmentId)]);
  });

  test('participates in a caller transaction so an order rollback also restores the cart', async () => {
    const buyer = await createUser('transaction-buyer');
    const seller = await createUser('transaction-seller', 'seller');
    const product = await createProduct(seller, 'transaction-product');
    const fulfillmentId = new mongoose.Types.ObjectId();
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 5 }],
    });

    const session = await mongoose.startSession();
    try {
      await expect(session.withTransaction(async () => {
        await removeFulfilledOrderItemsFromCart({
          userId: buyer._id,
          fulfillmentId,
          orderItems: [{ productId: product._id, quantity: 2 }],
          session,
        });
        throw new Error('simulated order transaction abort');
      })).rejects.toThrow('simulated order transaction abort');
    } finally {
      await session.endSession();
    }

    const cart = await Cart.findOne({ user: buyer._id }).select('+fulfilledOrderIds').lean();
    expect(cart.cartItems[0].qty).toBe(5);
    expect(cart.fulfilledOrderIds).toHaveLength(0);
  });

  test('an ambiguous response after the atomic write is safe to retry', async () => {
    const buyer = await createUser('ambiguous-buyer');
    const seller = await createUser('ambiguous-seller', 'seller');
    const product = await createProduct(seller, 'ambiguous-product');
    const fulfillmentId = new mongoose.Types.ObjectId();
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 5 }],
    });

    const cleanup = {
      userId: buyer._id,
      fulfillmentId,
      orderItems: [{ productId: product._id, quantity: 2 }],
    };
    const originalUpdateOne = Cart.updateOne.bind(Cart);
    const updateSpy = jest.spyOn(Cart, 'updateOne').mockImplementationOnce(async (...args) => {
      await originalUpdateOne(...args);
      throw new Error('simulated ambiguous database response');
    });
    await expect(removeFulfilledOrderItemsFromCart(cleanup)).rejects.toThrow('ambiguous database response');
    updateSpy.mockRestore();

    const retry = await removeFulfilledOrderItemsFromCart(cleanup);
    expect(retry).toEqual({ matchedLines: 0, removedQuantity: 0 });
    const cart = await Cart.findOne({ user: buyer._id }).select('+fulfilledOrderIds').lean();
    expect(cart.cartItems[0].qty).toBe(3);
    expect(cart.fulfilledOrderIds.map(String)).toEqual([String(fulfillmentId)]);
  });

  test.each(['2', true, 1.5, 0, -1, Number.NaN])(
    'rejects a present corrupt order-item quantity without mutating the cart (%p)',
    async (quantity) => {
      const buyer = await createUser(`bad-order-qty-${String(quantity)}`);
      const seller = await createUser(`bad-order-qty-seller-${String(quantity)}`, 'seller');
      const product = await createProduct(seller, `bad-order-qty-product-${String(quantity)}`);
      await Cart.create({
        user: buyer._id,
        cartItems: [{ product: product._id, qty: 4 }],
      });

      await expect(removeFulfilledOrderItemsFromCart({
        userId: buyer._id,
        fulfillmentId: new mongoose.Types.ObjectId(),
        orderItems: [{ productId: product._id, quantity }],
      })).rejects.toMatchObject({ code: 'CART_CLEANUP_DATA_INVALID', statusCode: 409 });

      expect((await Cart.findOne({ user: buyer._id }).lean()).cartItems[0].qty).toBe(4);
    },
  );

  test('rejects a corrupt persisted cart quantity before recording cleanup', async () => {
    const buyer = await createUser('bad-cart-qty');
    const seller = await createUser('bad-cart-qty-seller', 'seller');
    const product = await createProduct(seller, 'bad-cart-qty-product');
    const fulfillmentId = new mongoose.Types.ObjectId();
    const cart = await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 4 }],
    });
    await Cart.collection.updateOne(
      { _id: cart._id },
      { $set: { 'cartItems.0.qty': '4' } },
    );
    await Order.collection.insertOne({ _id: fulfillmentId, cartCleanupCompletedAt: null });

    await expect(removeFulfilledOrderItemsFromCart({
      userId: buyer._id,
      fulfillmentId,
      orderItems: [{ productId: product._id, quantity: 2 }],
    })).rejects.toMatchObject({ code: 'CART_CLEANUP_DATA_INVALID', statusCode: 409 });

    const [rawCart, rawOrder] = await Promise.all([
      Cart.collection.findOne({ _id: cart._id }),
      Order.collection.findOne({ _id: fulfillmentId }),
    ]);
    expect(rawCart.cartItems[0].qty).toBe('4');
    expect(rawOrder.cartCleanupCompletedAt).toBeNull();
  });

  test('preserves the documented quantity-one meaning for a nullish legacy cart row', async () => {
    const buyer = await createUser('legacy-missing-qty');
    const seller = await createUser('legacy-missing-qty-seller', 'seller');
    const product = await createProduct(seller, 'legacy-missing-qty-product');
    const cart = await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 1 }],
    });
    await Cart.collection.updateOne(
      { _id: cart._id },
      { $unset: { 'cartItems.0.qty': '' } },
    );

    await expect(removeFulfilledOrderItemsFromCart({
      userId: buyer._id,
      fulfillmentId: new mongoose.Types.ObjectId(),
      orderItems: [{ productId: product._id, quantity: 1 }],
    })).resolves.toEqual({ matchedLines: 1, removedQuantity: 1 });

    expect((await Cart.findOne({ user: buyer._id }).lean()).cartItems).toHaveLength(0);
  });
});
