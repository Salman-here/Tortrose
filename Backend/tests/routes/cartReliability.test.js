const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const cartRoutes = require('../../routes/cartRoutes');
const Cart = require('../../models/Cart');
const Product = require('../../models/Product');
const User = require('../../models/User');

let app;
let mongoServer;

const tokenFor = (user) =>
  `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}`;

const createUser = (suffix, role = 'user') => User.create({
  username: `cart-reliability-${role}-${suffix}`,
  email: `cart-reliability-${role}-${suffix}@test.com`,
  password: 'password123',
  role,
  currency: 'PKR',
});

const createProduct = (seller, suffix, stock = 10) => Product.create({
  name: `Cart Reliability Product ${suffix}`,
  description: `Cart reliability product ${suffix} for API testing.`,
  price: 500,
  currency: 'PKR',
  priceCurrency: 'PKR',
  category: 'Test',
  brand: 'Rozare',
  stock,
  image: `https://example.com/${suffix}.jpg`,
  images: [{ url: `https://example.com/${suffix}.jpg` }],
  seller: seller._id,
});

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cart-reliability-test-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  app = express();
  app.use(express.json());
  app.use('/api/cart', cartRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([
    Cart.deleteMany({}),
    Product.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('cart reliability status contracts', () => {
  test('rejects adding an out-of-stock product with a conflict response', async () => {
    const buyer = await createUser('buyer');
    const seller = await createUser('seller', 'seller');
    const product = await createProduct(seller, 'out-of-stock', 0);

    const response = await request(app)
      .post(`/api/cart/add/${product._id}`)
      .set('Authorization', tokenFor(buyer))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ msg: 'Product is out of stock' });
    expect(await Cart.countDocuments({ user: buyer._id })).toBe(0);
  });

  test.each([
    ['patch', '/api/cart/qty-inc/'],
    ['patch', '/api/cart/qty-dec/'],
    ['delete', '/api/cart/remove/'],
  ])('%s returns 404 when the user has no cart', async (method, path) => {
    const buyer = await createUser(`missing-cart-${method}`);
    const lineId = new mongoose.Types.ObjectId();

    const response = await request(app)[method](`${path}${lineId}`)
      .set('Authorization', tokenFor(buyer));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ msg: 'cart not found' });
  });

  test.each([
    ['patch', '/api/cart/qty-inc/'],
    ['patch', '/api/cart/qty-dec/'],
    ['delete', '/api/cart/remove/'],
  ])('%s returns 404 when the requested cart line does not exist', async (method, path) => {
    const buyer = await createUser(`missing-line-${method}`);
    await Cart.create({ user: buyer._id, cartItems: [] });
    const lineId = new mongoose.Types.ObjectId();

    const response = await request(app)[method](`${path}${lineId}`)
      .set('Authorization', tokenFor(buyer));

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ msg: 'Cart item not found' });
  });

  test('uses 409, not an authentication status, when quantity is already one', async () => {
    const buyer = await createUser('minimum-quantity');
    const seller = await createUser('minimum-quantity-seller', 'seller');
    const product = await createProduct(seller, 'minimum-quantity', 5);
    const cart = await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 1 }],
    });
    const lineId = cart.cartItems[0]._id;

    const response = await request(app)
      .patch(`/api/cart/qty-dec/${lineId}`)
      .set('Authorization', tokenFor(buyer));

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ msg: 'Quantity cannot be less than 1' });
  });
});
