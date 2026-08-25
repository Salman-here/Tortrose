const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');
const orderRoutes = require('../../routes/orderRoutes');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const User = require('../../models/User');
const Cart = require('../../models/Cart');

let mongoServer;
let app;

const tokenFor = (user, role = user.role) =>
  `Bearer ${jwt.sign({ id: user._id.toString(), role }, process.env.JWT_SECRET)}`;

const createUser = (suffix, role = 'user') =>
  User.create({
    username: `${role}${suffix}`,
    email: `${role}${suffix}@test.com`,
    password: 'password123',
    role,
  });

const createProduct = (seller, suffix, price = 100) =>
  Product.create({
    name: `Product ${suffix}`,
    description: `Product ${suffix} description`,
    price,
    category: 'Test',
    brand: 'Test Brand',
    stock: 10,
    image: `https://example.com/${suffix}.jpg`,
    images: [{ url: `https://example.com/${suffix}.jpg` }],
    seller: seller._id,
  });

const createOrder = ({ buyer, sellerProduct, otherProduct }) =>
  Order.create({
    user: buyer._id,
    orderId: `ORD-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    orderItems: [
      {
        productId: sellerProduct._id,
        name: sellerProduct.name,
        image: sellerProduct.image,
        price: sellerProduct.price,
        quantity: 2,
      },
      {
        productId: otherProduct._id,
        name: otherProduct.name,
        image: otherProduct.image,
        price: otherProduct.price,
        quantity: 1,
      },
    ],
    shippingInfo: {
      fullName: 'Buyer One',
      email: buyer.email,
      phone: '+923001234567',
      address: '123 Test Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: {
      name: 'standard',
      price: 15,
      estimatedDays: 5,
      seller: sellerProduct.seller,
    },
    sellerShipping: [
      { seller: sellerProduct.seller, shippingMethod: { name: 'standard', price: 10, estimatedDays: 5 } },
      { seller: otherProduct.seller, shippingMethod: { name: 'standard', price: 5, estimatedDays: 5 } },
    ],
    orderSummary: {
      subtotal: sellerProduct.price * 2 + otherProduct.price,
      shippingCost: 15,
      tax: 25,
      totalAmount: sellerProduct.price * 2 + otherProduct.price + 40,
    },
    paymentMethod: 'cash_on_delivery',
    isPaid: true,
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'order-access-test-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/order', orderRoutes);
}, 60000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 60000);

beforeEach(async () => {
  await Order.deleteMany({});
  await Product.deleteMany({});
  await User.deleteMany({});
  await Cart.deleteMany({});
});

describe('Order access isolation', () => {
  test('rejects anonymous order placement before processing checkout data', async () => {
    const res = await request(app)
      .post('/api/order/place')
      .send({ order: {} });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ msg: 'No token provided!' });
  });

  test('does not treat a buyer token as admin for order lists', async () => {
    const buyer = await createUser('buyer-list', 'user');

    const res = await request(app)
      .get('/api/order/get')
      .set('Authorization', tokenFor(buyer));

    expect(res.status).toBe(403);
  });

  test('uses the live database role when a token contains a stale role', async () => {
    const seller = await createUser('seller-stale', 'seller');
    const otherSeller = await createUser('seller-other', 'seller');
    const buyer = await createUser('buyer-stale', 'user');
    const sellerProduct = await createProduct(seller, 'seller-stale', 100);
    const otherProduct = await createProduct(otherSeller, 'other-stale', 50);
    await createOrder({ buyer, sellerProduct, otherProduct });

    const staleBuyerRoleToken = tokenFor(seller, 'user');
    const res = await request(app)
      .get('/api/order/get')
      .set('Authorization', staleBuyerRoleToken);

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].orderItems).toHaveLength(1);
    expect(res.body.orders[0].orderItems[0].productId.toString()).toBe(sellerProduct._id.toString());
  });

  test('new seller with no products sees an empty order list', async () => {
    const seller = await createUser('seller-empty', 'seller');

    const res = await request(app)
      .get('/api/order/get')
      .set('Authorization', tokenFor(seller));

    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  test('seller order list includes only seller line items and seller total', async () => {
    const seller = await createUser('seller-scope', 'seller');
    const otherSeller = await createUser('seller-scope-other', 'seller');
    const buyer = await createUser('buyer-scope', 'user');
    const sellerProduct = await createProduct(seller, 'seller-scope', 100);
    const otherProduct = await createProduct(otherSeller, 'other-scope', 50);
    await createOrder({ buyer, sellerProduct, otherProduct });

    const res = await request(app)
      .get('/api/order/get')
      .set('Authorization', tokenFor(seller));

    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].orderItems).toHaveLength(1);
    expect(res.body.orders[0].orderSummary.subtotal).toBe(200);
    expect(res.body.orders[0].orderSummary.shippingCost).toBe(10);
    expect(res.body.orders[0].orderSummary.tax).toBe(20);
    expect(res.body.orders[0].orderSummary.totalAmount).toBe(230);
    expect(res.body.orders[0].orderSummary).not.toHaveProperty('_originalTotal');
  });

  test('treats an order-item seller snapshot as authoritative over current product ownership', async () => {
    const seller = await createUser('snapshot-owner', 'seller');
    const snapshotSeller = await createUser('snapshot-other', 'seller');
    const buyer = await createUser('snapshot-buyer', 'user');
    const currentlyOwnedProduct = await createProduct(seller, 'snapshot-current', 100);
    const otherProduct = await createProduct(snapshotSeller, 'snapshot-other', 50);
    const order = await createOrder({
      buyer,
      sellerProduct: currentlyOwnedProduct,
      otherProduct,
    });

    order.orderItems[0].seller = snapshotSeller._id;
    order.orderItems[1].seller = snapshotSeller._id;
    await order.save();

    const listResponse = await request(app)
      .get('/api/order/get')
      .set('Authorization', tokenFor(seller));
    const updateResponse = await request(app)
      .patch(`/api/order/update-status/${order._id}`)
      .send({ newStatus: 'processing' })
      .set('Authorization', tokenFor(seller));

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.orders).toEqual([]);
    expect(updateResponse.status).toBe(403);
    expect(updateResponse.body.msg).toBe('You can only update orders containing your products');
  });

  test('seller CSV export stays seller-scoped and labels totals in the requested report currency', async () => {
    const seller = await createUser('export-seller', 'seller');
    const otherSeller = await createUser('export-other', 'seller');
    const buyer = await createUser('export-buyer', 'user');
    const sellerProduct = await createProduct(seller, 'export-seller', 100);
    const otherProduct = await createProduct(otherSeller, 'export-other', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });
    order.currency = 'PKR';
    order.shippingInfo.fullName = '=HYPERLINK("https://evil.example","click")';
    order.orderItems[0].name = '@SUM(1+1)';
    await order.save();

    const response = await request(app)
      .get('/api/order/export?format=csv&currency=PKR')
      .set('Authorization', tokenFor(seller));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Grand Total: PKR 230.00');
    expect(response.text).toContain('Subtotal (PKR)');
    expect(response.text).toContain("'@SUM(1+1)");
    expect(response.text).not.toContain('Product export-other');
    expect(response.text).not.toContain('$230.00');
    expect(response.text).toContain("'=HYPERLINK");
    expect(response.text).not.toContain('"=HYPERLINK');
  });

  test('seller cannot view or update an awaiting-payment Checkout order by id', async () => {
    const seller = await createUser('seller-awaiting', 'seller');
    const otherSeller = await createUser('seller-awaiting-other', 'seller');
    const buyer = await createUser('buyer-awaiting', 'user');
    const sellerProduct = await createProduct(seller, 'seller-awaiting', 100);
    const otherProduct = await createProduct(otherSeller, 'other-awaiting', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });
    order.awaitingPayment = true;
    order.isPaid = false;
    await order.save();

    const detailResponse = await request(app)
      .get(`/api/order/detail/${order._id}`)
      .set('Authorization', tokenFor(seller));
    const updateResponse = await request(app)
      .patch(`/api/order/update-status/${order._id}`)
      .send({ newStatus: 'processing' })
      .set('Authorization', tokenFor(seller));

    expect(detailResponse.status).toBe(404);
    expect(detailResponse.body).toEqual({ msg: 'Order not found' });
    expect(updateResponse.status).toBe(404);
    expect(updateResponse.body).toEqual({ msg: 'Order not found' });

    const unchanged = await Order.findById(order._id);
    expect(unchanged.orderStatus).toBe('pending');
    expect(unchanged.awaitingPayment).toBe(true);
  });

  test('buyers can view their own order but not another buyer order', async () => {
    const seller = await createUser('seller-detail', 'seller');
    const otherSeller = await createUser('seller-detail-other', 'seller');
    const buyer = await createUser('buyer-detail', 'user');
    const otherBuyer = await createUser('buyer-detail-other', 'user');
    const sellerProduct = await createProduct(seller, 'seller-detail', 100);
    const otherProduct = await createProduct(otherSeller, 'other-detail', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });

    const ownRes = await request(app)
      .get(`/api/order/detail/${order._id}`)
      .set('Authorization', tokenFor(buyer));

    const otherRes = await request(app)
      .get(`/api/order/detail/${order._id}`)
      .set('Authorization', tokenFor(otherBuyer));

    expect(ownRes.status).toBe(200);
    expect(otherRes.status).toBe(403);
  });

  test('buyers cannot update order status or cancel another buyer order', async () => {
    const seller = await createUser('seller-write', 'seller');
    const otherSeller = await createUser('seller-write-other', 'seller');
    const buyer = await createUser('buyer-write', 'user');
    const otherBuyer = await createUser('buyer-write-other', 'user');
    const sellerProduct = await createProduct(seller, 'seller-write', 100);
    const otherProduct = await createProduct(otherSeller, 'other-write', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });

    const updateRes = await request(app)
      .patch(`/api/order/update-status/${order._id}`)
      .send({ newStatus: 'confirmed' })
      .set('Authorization', tokenFor(otherBuyer));

    const cancelRes = await request(app)
      .patch(`/api/order/cancel/${order._id}`)
      .set('Authorization', tokenFor(otherBuyer));

    expect(updateRes.status).toBe(403);
    expect(cancelRes.status).toBe(403);
  });

  test('exposes only webhook-fulfilled payment status to the owning buyer', async () => {
    const seller = await createUser('seller-payment', 'seller');
    const otherSeller = await createUser('seller-payment-other', 'seller');
    const buyer = await createUser('buyer-payment', 'user');
    const otherBuyer = await createUser('buyer-payment-other', 'user');
    const sellerProduct = await createProduct(seller, 'seller-payment', 100);
    const otherProduct = await createProduct(otherSeller, 'other-payment', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });
    order.paymentMethod = 'stripe';
    order.stripeSessionId = 'cs_test_verified';
    order.awaitingPayment = false;
    order.inventoryCommitted = true;
    order.paymentFulfilledAt = new Date();
    order.isPaid = true;
    await order.save();

    const ownRes = await request(app)
      .get(`/api/order/payment-status/${order.orderId}?sessionId=cs_test_verified`)
      .set('Authorization', tokenFor(buyer));
    const otherRes = await request(app)
      .get(`/api/order/payment-status/${order.orderId}?sessionId=cs_test_verified`)
      .set('Authorization', tokenFor(otherBuyer));
    const mismatchRes = await request(app)
      .get(`/api/order/payment-status/${order.orderId}?sessionId=cs_wrong`)
      .set('Authorization', tokenFor(buyer));

    expect(ownRes.status).toBe(200);
    expect(ownRes.body).toMatchObject({
      status: 'paid',
      isPaid: true,
      webhookProcessed: true,
      orderId: order.orderId,
    });
    expect(otherRes.status).toBe(403);
    expect(mismatchRes.status).toBe(400);
    expect(mismatchRes.body.code).toBe('PAYMENT_SESSION_MISMATCH');
  });

  test('registers buyer reorder and invoice routes with strict ownership', async () => {
    const seller = await createUser('seller-actions', 'seller');
    const otherSeller = await createUser('seller-actions-other', 'seller');
    const buyer = await createUser('buyer-actions', 'user');
    const otherBuyer = await createUser('buyer-actions-other', 'user');
    const sellerProduct = await createProduct(seller, 'seller-actions', 100);
    const otherProduct = await createProduct(otherSeller, 'other-actions', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });
    order.currency = 'PKR';
    await order.save();

    const reorderRes = await request(app)
      .post(`/api/order/reorder/${order._id}`)
      .set('Authorization', tokenFor(buyer));
    const invoiceRes = await request(app)
      .get(`/api/order/invoice/${order._id}`)
      .set('Authorization', tokenFor(buyer));
    const forbiddenInvoice = await request(app)
      .get(`/api/order/invoice/${order._id}`)
      .set('Authorization', tokenFor(otherBuyer));

    expect(reorderRes.status).toBe(200);
    expect(reorderRes.body).toMatchObject({ added: 2, unavailable: 0 });
    expect(invoiceRes.status).toBe(200);
    expect(invoiceRes.body.html).toContain(`Invoice #${order.orderId}`);
    expect(invoiceRes.body.html).toContain('PKR');
    expect(invoiceRes.body.html).not.toContain('$290.00');
    expect(forbiddenInvoice.status).toBe(403);
  });

  test.each([true, '2', 1.5, 0])(
    'fails closed before cart mutation for corrupt raw order quantity %p',
    async quantity => {
      const seller = await createUser(`seller-reorder-${String(quantity)}`, 'seller');
      const otherSeller = await createUser(`other-reorder-${String(quantity)}`, 'seller');
      const buyer = await createUser(`buyer-reorder-${String(quantity)}`, 'user');
      const sellerProduct = await createProduct(seller, `reorder-${String(quantity)}`, 100);
      const otherProduct = await createProduct(otherSeller, `other-reorder-${String(quantity)}`, 50);
      const order = await createOrder({ buyer, sellerProduct, otherProduct });
      await Order.collection.updateOne(
        { _id: order._id },
        { $set: { 'orderItems.0.quantity': quantity } },
      );

      const res = await request(app)
        .post(`/api/order/reorder/${order._id}`)
        .set('Authorization', tokenFor(buyer));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ORDER_REORDER_QUANTITY_INVALID');
      expect(await Cart.findOne({ user: buyer._id })).toBeNull();
    },
  );

  test('fails closed without repairing a corrupt existing cart quantity', async () => {
    const seller = await createUser('seller-reorder-cart', 'seller');
    const otherSeller = await createUser('other-reorder-cart', 'seller');
    const buyer = await createUser('buyer-reorder-cart', 'user');
    const sellerProduct = await createProduct(seller, 'reorder-cart', 100);
    const otherProduct = await createProduct(otherSeller, 'other-reorder-cart', 50);
    const order = await createOrder({ buyer, sellerProduct, otherProduct });
    const insertedCart = await Cart.collection.insertOne({
      user: buyer._id,
      cartItems: [{
        _id: new mongoose.Types.ObjectId(),
        product: sellerProduct._id,
        qty: false,
        selectedColor: null,
      }],
      fulfilledOrderIds: [],
      totalCartPrice: 0,
      totalCartCurrency: 'USD',
    });

    const res = await request(app)
      .post(`/api/order/reorder/${order._id}`)
      .set('Authorization', tokenFor(buyer));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CART_REORDER_QUANTITY_INVALID');
    const rawCart = await Cart.collection.findOne({ _id: insertedCart.insertedId });
    expect(rawCart.cartItems[0].qty).toBe(false);
  });
});
