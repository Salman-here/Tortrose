const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const productRoutes = require('../../routes/productRoutes');
const storeRoutes = require('../../routes/storeRoutes');
const storeReviewRoutes = require('../../routes/storeReviewRoutes');
const Notification = require('../../models/Notification');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const StoreReview = require('../../models/StoreReview');
const User = require('../../models/User');

let mongoServer;
let app;

const shippingInfo = {
  fullName: 'Buyer One',
  email: 'buyer@example.com',
  phone: '+923001234567',
  address: '123 Test Street',
  city: 'Lahore',
  state: 'Punjab',
  postalCode: '54000',
  country: 'Pakistan',
};

const tokenFor = (user) =>
  `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}`;

const createUser = (role, suffix) => User.create({
  username: `${role}-${suffix}`,
  email: `${role}-${suffix}@example.com`,
  password: 'password123',
  role,
  currency: 'PKR',
});

const createStoreFor = (seller, suffix) => Store.create({
  seller: seller._id,
  storeName: `Review Store ${suffix}`,
  storeSlug: `review-store-${suffix}`,
  visibility: { mode: 'global' },
});

const createProductFor = (seller, suffix) => Product.create({
  seller: seller._id,
  name: `Review Product ${suffix}`,
  description: `A useful product for ${suffix}`,
  price: 1200,
  currency: 'PKR',
  priceCurrency: 'PKR',
  category: 'Testing',
  brand: 'Rozare',
  stock: 10,
  image: `https://example.com/${suffix}.jpg`,
  images: [{ url: `https://example.com/${suffix}.jpg` }],
});

const createOrder = ({ buyer, storeA, storeB, productA, productB, statusA = 'processing', statusB = 'processing' }) =>
  Order.create({
    user: buyer._id,
    orderId: `TEST-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    currency: 'PKR',
    orderItems: [
      {
        productId: productA._id,
        seller: storeA.seller,
        name: productA.name,
        image: productA.image,
        price: productA.price,
        quantity: 1,
      },
      {
        productId: productB._id,
        seller: storeB.seller,
        name: productB.name,
        image: productB.image,
        price: productB.price,
        quantity: 1,
      },
    ],
    shippingInfo,
    shippingMethod: {
      name: 'standard',
      price: 0,
      estimatedDays: 5,
      seller: storeA.seller,
    },
    sellerShipping: [
      { seller: storeA.seller, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } },
      { seller: storeB.seller, shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 } },
    ],
    sellerFulfillment: [
      { seller: storeA.seller, status: statusA, deliveredAt: statusA === 'delivered' ? new Date() : null },
      { seller: storeB.seller, status: statusB, deliveredAt: statusB === 'delivered' ? new Date() : null },
    ],
    sellerPolicies: [
      { seller: storeA.seller, store: storeA._id, storeName: storeA.storeName },
      { seller: storeB.seller, store: storeB._id, storeName: storeB.storeName },
    ],
    orderSummary: {
      subtotal: productA.price + productB.price,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: productA.price + productB.price,
    },
    orderStatus: 'processing',
    paymentMethod: 'stripe',
    isPaid: true,
    paidAt: new Date(),
    awaitingPayment: false,
    confirmation: { confirmedAt: new Date(), declinedAt: null },
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'store-review-test-secret';
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  app.use('/api/stores', storeRoutes);
  app.use('/api/store-reviews', storeReviewRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([
    Notification.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    Store.deleteMany({}),
    StoreReview.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 60000);

describe('store reviews and verified purchase eligibility', () => {
  test('requires a delivered seller portion before store or product reviews unlock', async () => {
    const buyer = await createUser('user', 'buyer');
    const sellerA = await createUser('seller', 'delivered');
    const sellerB = await createUser('seller', 'processing');
    const storeA = await createStoreFor(sellerA, 'delivered');
    const storeB = await createStoreFor(sellerB, 'processing');
    const productA = await createProductFor(sellerA, 'delivered');
    const productB = await createProductFor(sellerB, 'processing');
    const auth = tokenFor(buyer);

    await createOrder({ buyer, storeA, storeB, productA, productB, statusA: 'delivered', statusB: 'processing' });

    const storeAReview = await request(app)
      .post(`/api/store-reviews/${storeA._id}`)
      .set('Authorization', auth)
      .send({ rating: 5, title: 'Good store', comment: 'Delivered this part correctly.' });

    expect(storeAReview.status).toBe(201);
    expect(storeAReview.body.review).toMatchObject({
      rating: 5,
      isVerifiedPurchase: true,
    });
    expect(storeAReview.body.review.order).toBeTruthy();
    expect(storeAReview.body.summary).toMatchObject({ average: 5, count: 1 });

    const storeBReview = await request(app)
      .post(`/api/store-reviews/${storeB._id}`)
      .set('Authorization', auth)
      .send({ rating: 4, comment: 'Not delivered yet.' });

    expect(storeBReview.status).toBe(403);
    expect(storeBReview.body.reason).toBe('order_not_delivered');

    const productAReview = await request(app)
      .post(`/api/products/add-review/${productA._id}`)
      .set('Authorization', auth)
      .send({ rating: 5, comment: 'Product from delivered seller is ready to review.' });

    expect(productAReview.status).toBe(200);
    const savedProductA = await Product.findById(productA._id).lean();
    expect(savedProductA.reviews).toHaveLength(1);
    expect(savedProductA.reviews[0].isVerifiedPurchase).toBe(true);

    const productBReview = await request(app)
      .post(`/api/products/add-review/${productB._id}`)
      .set('Authorization', auth)
      .send({ rating: 4, comment: 'This seller has not delivered yet.' });

    expect(productBReview.status).toBe(403);
    expect(productBReview.body.reason).toBe('order_not_delivered');
  });

  test('blocks unverified and own-store store reviews from public rating summaries', async () => {
    const buyer = await createUser('user', 'summary-buyer');
    const seller = await createUser('seller', 'summary-seller');
    const store = await createStoreFor(seller, 'summary');
    const product = await createProductFor(seller, 'summary');
    const otherSeller = await createUser('seller', 'other');
    const otherStore = await createStoreFor(otherSeller, 'other');
    const otherProduct = await createProductFor(otherSeller, 'other');

    await createOrder({
      buyer,
      storeA: store,
      storeB: otherStore,
      productA: product,
      productB: otherProduct,
      statusA: 'delivered',
      statusB: 'delivered',
    });

    await StoreReview.create({
      store: store._id,
      user: new mongoose.Types.ObjectId(),
      rating: 1,
      comment: 'legacy unverified review',
      isVerifiedPurchase: false,
    });

    const ownStoreReview = await request(app)
      .post(`/api/store-reviews/${store._id}`)
      .set('Authorization', tokenFor(seller))
      .send({ rating: 5, comment: 'Owner should not be able to review.' });

    expect(ownStoreReview.status).toBe(403);

    const created = await request(app)
      .post(`/api/store-reviews/${store._id}`)
      .set('Authorization', tokenFor(buyer))
      .send({ rating: 4, comment: 'Verified delivered purchase.' });

    expect(created.status).toBe(201);

    const summary = await request(app).get(`/api/store-reviews/${store._id}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toMatchObject({ average: 4, count: 1 });
    expect(summary.body.summary.distribution).toMatchObject({ 4: 1 });

    const reviews = await request(app).get(`/api/store-reviews/${store._id}`);
    expect(reviews.status).toBe(200);
    expect(reviews.body.reviews).toHaveLength(1);
    expect(reviews.body.reviews[0].isVerifiedPurchase).toBe(true);
    expect(reviews.body.reviews[0].order).toBeUndefined();

    const stores = await request(app).get('/api/stores/all?sort=rating');
    expect(stores.status).toBe(200);
    const listedStore = stores.body.stores.find((item) => item._id === store._id.toString());
    expect(listedStore).toMatchObject({ ratingAverage: 4, ratingCount: 1 });
  });

  test('updates one verified store review per buyer and refreshes aggregate rating', async () => {
    const buyer = await createUser('user', 'update-buyer');
    const seller = await createUser('seller', 'update-seller');
    const store = await createStoreFor(seller, 'update');
    const product = await createProductFor(seller, 'update');
    const otherSeller = await createUser('seller', 'update-other');
    const otherStore = await createStoreFor(otherSeller, 'update-other');
    const otherProduct = await createProductFor(otherSeller, 'update-other');
    const auth = tokenFor(buyer);

    await createOrder({
      buyer,
      storeA: store,
      storeB: otherStore,
      productA: product,
      productB: otherProduct,
      statusA: 'delivered',
      statusB: 'delivered',
    });

    const first = await request(app)
      .post(`/api/store-reviews/${store._id}`)
      .set('Authorization', auth)
      .send({ rating: 3, comment: 'Initial rating.' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/store-reviews/${store._id}`)
      .set('Authorization', auth)
      .send({ rating: 5, title: 'Updated', comment: 'Updated rating.' });

    expect(second.status).toBe(200);
    expect(second.body.summary).toMatchObject({ average: 5, count: 1 });
    expect(await StoreReview.countDocuments({ store: store._id, user: buyer._id })).toBe(1);
    expect(await Notification.countDocuments({ user: seller._id, title: 'New store rating' })).toBe(0);
    const sellerRows = await NotificationOutbox.find({
      eventType: 'store.review_created',
      'recipient.user': seller._id,
      'recipient.audienceRole': 'seller',
    }).sort({ channel: 1 }).lean();
    expect(sellerRows).toHaveLength(4);
    expect(sellerRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(new Set(sellerRows.map(row => row.eventKey)).size).toBe(1);
    expect(sellerRows.find(row => row.channel === 'push').payload).toMatchObject({
      linkTo: `/store/${store.storeSlug}#store-reviews`,
      channelId: 'seller',
      data: expect.objectContaining({ type: 'new_review', audienceRole: 'seller' }),
    });
    expect(sellerRows.every(row => row.payload.data.rating === 3)).toBe(true);
  });
});
