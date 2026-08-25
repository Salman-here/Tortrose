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

const createUser = () => User.create({
  username: 'cart-merge-buyer',
  email: 'cart-merge-buyer@test.com',
  password: 'password123',
  role: 'user',
  currency: 'PKR',
});

const createProduct = (seller, suffix, stock = 10) => Product.create({
  name: `Merge Product ${suffix}`,
  description: `Merge product ${suffix} for checkout testing.`,
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'cart-merge-test-secret';
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

describe('guest cart merge', () => {
  test('preserves quantities and product options when a guest signs in', async () => {
    const buyer = await createUser();
    const seller = await User.create({
      username: 'cart-merge-seller',
      email: 'cart-merge-seller@test.com',
      password: 'password123',
      role: 'seller',
      currency: 'PKR',
    });
    const product = await createProduct(seller, 'options', 8);

    const res = await request(app)
      .post('/api/cart/merge')
      .set('Authorization', tokenFor(buyer))
      .send({
        items: [{
          productId: product._id.toString(),
          qty: 3,
          selectedColor: 'Black',
          selectedOptions: { Size: 'Large' },
        }],
      });

    expect(res.status).toBe(200);
    expect(res.body.cart).toHaveLength(1);
    expect(res.body.cart[0]).toMatchObject({
      qty: 3,
      selectedColor: 'Black',
      selectedOptions: { Size: 'Large' },
    });
  });

  test('merges matching lines and caps the result at current stock', async () => {
    const buyer = await createUser();
    const seller = await User.create({
      username: 'cart-stock-seller',
      email: 'cart-stock-seller@test.com',
      password: 'password123',
      role: 'seller',
      currency: 'PKR',
    });
    const product = await createProduct(seller, 'stock', 5);
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 4, selectedColor: 'Blue' }],
    });

    const res = await request(app)
      .post('/api/cart/merge')
      .set('Authorization', tokenFor(buyer))
      .send({ items: [{ productId: product._id.toString(), qty: 3, selectedColor: 'Blue' }] });

    expect(res.status).toBe(200);
    expect(res.body.cart).toHaveLength(1);
    expect(res.body.cart[0].qty).toBe(5);
  });

  test.each([true, '5', 1.5, -1, Number.POSITIVE_INFINITY])(
    'fails closed for corrupt raw product stock %p',
    async stock => {
      const buyer = await createUser();
      const seller = await User.create({
        username: `cart-stock-corrupt-${String(stock)}`,
        email: `cart-stock-corrupt-${String(stock)}@test.com`,
        password: 'password123',
        role: 'seller',
        currency: 'PKR',
      });
      const product = await createProduct(seller, `corrupt-${String(stock)}`, 5);
      await Product.collection.updateOne({ _id: product._id }, { $set: { stock } });

      const res = await request(app)
        .post('/api/cart/merge')
        .set('Authorization', tokenFor(buyer))
        .send({ items: [{ productId: product._id.toString(), qty: 1 }] });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PRODUCT_STOCK_INVALID');
      expect(await Cart.findOne({ user: buyer._id })).toBeNull();
    },
  );

  test('fails closed without repairing a corrupt raw existing-cart quantity', async () => {
    const buyer = await createUser();
    const seller = await User.create({
      username: 'cart-qty-corrupt-seller',
      email: 'cart-qty-corrupt-seller@test.com',
      password: 'password123',
      role: 'seller',
      currency: 'PKR',
    });
    const product = await createProduct(seller, 'qty-corrupt', 5);
    const cart = await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 1 }],
    });
    await Cart.collection.updateOne(
      { _id: cart._id },
      { $set: { 'cartItems.0.qty': '1' } },
    );

    const res = await request(app)
      .post('/api/cart/merge')
      .set('Authorization', tokenFor(buyer))
      .send({ items: [{ productId: product._id.toString(), qty: 1 }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CART_QUANTITY_INVALID');
    const rawCart = await Cart.collection.findOne({ _id: cart._id });
    expect(rawCart.cartItems[0].qty).toBe('1');
  });

  test('does not relabel a present corrupt user currency as USD', async () => {
    const buyer = await createUser();
    await User.collection.updateOne({ _id: buyer._id }, { $set: { currency: '' } });

    const res = await request(app)
      .post('/api/cart/merge')
      .set('Authorization', tokenFor(buyer))
      .send({ items: [] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('USER_CURRENCY_INVALID');
  });
});
