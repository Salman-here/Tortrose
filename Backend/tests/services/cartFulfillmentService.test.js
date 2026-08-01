const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Cart = require('../../models/Cart');
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
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 60000);

afterEach(async () => {
  await Promise.all([Cart.deleteMany({}), Product.deleteMany({}), User.deleteMany({})]);
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
});
