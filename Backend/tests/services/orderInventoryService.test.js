const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const { commitOrderInventory, restoreOrderInventory } = require('../../services/orderInventoryService');

let replSet;

const productData = (suffix, stock) => ({
  name: `Inventory ${suffix}`,
  description: `Inventory reservation test product ${suffix}.`,
  price: 100,
  currency: 'PKR',
  priceCurrency: 'PKR',
  category: 'Test',
  brand: 'Rozare',
  stock,
  image: `https://example.com/${suffix}.jpg`,
  images: [{ url: `https://example.com/${suffix}.jpg` }],
});

const createOrder = (items) => Order.create({
  orderId: `ORD-INVENTORY-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  currency: 'PKR',
  orderItems: items.map(({ product, quantity }) => ({
    productId: product._id,
    name: product.name,
    image: product.image,
    price: product.price,
    quantity,
  })),
  shippingInfo: {
    fullName: 'Inventory Buyer',
    email: 'inventory@test.com',
    phone: '+923001234567',
    address: '123 Test Street',
    city: 'Lahore',
    state: 'Punjab',
    postalCode: '54000',
    country: 'Pakistan',
  },
  shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 },
  orderSummary: {
    subtotal: items.reduce((sum, item) => sum + item.product.price * item.quantity, 0),
    shippingCost: 0,
    tax: 0,
    couponDiscount: 0,
    totalAmount: items.reduce((sum, item) => sum + item.product.price * item.quantity, 0),
  },
  paymentMethod: 'stripe',
  awaitingPayment: true,
});

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
}, 60000);

afterEach(async () => {
  await Promise.all([Order.deleteMany({}), Product.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60000);

describe('order inventory reservation', () => {
  test('commits and restores all lines exactly once', async () => {
    const first = await Product.create(productData('first', 5));
    const second = await Product.create(productData('second', 3));
    const order = await createOrder([
      { product: first, quantity: 2 },
      { product: second, quantity: 1 },
    ]);

    await commitOrderInventory(order._id);
    await commitOrderInventory(order._id);
    expect(await Product.findById(first._id).lean()).toMatchObject({ stock: 3, totalSales: 2 });
    expect(await Product.findById(second._id).lean()).toMatchObject({ stock: 2, totalSales: 1 });
    expect((await Order.findById(order._id)).inventoryCommitted).toBe(true);

    await restoreOrderInventory(order._id);
    await restoreOrderInventory(order._id);
    expect(await Product.findById(first._id).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect(await Product.findById(second._id).lean()).toMatchObject({ stock: 3, totalSales: 0 });
    expect((await Order.findById(order._id)).inventoryCommitted).toBe(false);
  });

  test('rolls the entire reservation back when any line lacks stock', async () => {
    const enough = await Product.create(productData('enough', 5));
    const short = await Product.create(productData('short', 1));
    const order = await createOrder([
      { product: enough, quantity: 2 },
      { product: short, quantity: 2 },
    ]);

    await expect(commitOrderInventory(order._id)).rejects.toMatchObject({
      code: 'ORDER_STOCK_CHANGED',
      statusCode: 409,
    });
    expect(await Product.findById(enough._id).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect(await Product.findById(short._id).lean()).toMatchObject({ stock: 1, totalSales: 0 });
    expect((await Order.findById(order._id)).inventoryCommitted).toBe(false);
  });

  test('aggregates duplicate product lines before checking stock', async () => {
    const product = await Product.create(productData('duplicate', 1));
    const order = await createOrder([
      { product, quantity: 1 },
      { product, quantity: 1 },
    ]);

    await expect(commitOrderInventory(order._id)).rejects.toMatchObject({
      code: 'ORDER_STOCK_CHANGED',
      statusCode: 409,
    });
    expect(await Product.findById(product._id).lean()).toMatchObject({ stock: 1, totalSales: 0 });
    expect((await Order.findById(order._id)).inventoryCommitted).toBe(false);
  });

  test('allows exactly one concurrent stock=1 reservation and leaves no partial state', async () => {
    const product = await Product.create(productData('race', 1));
    const first = await createOrder([{ product, quantity: 1 }]);
    const second = await createOrder([{ product, quantity: 1 }]);

    const results = await Promise.allSettled([
      commitOrderInventory(first._id),
      commitOrderInventory(second._id),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({
      code: 'ORDER_STOCK_CHANGED',
    });
    expect(await Product.findById(product._id).lean()).toMatchObject({ stock: 0, totalSales: 1 });
    const orders = await Order.find({ _id: { $in: [first._id, second._id] } }).lean();
    expect(orders.filter(order => order.inventoryCommitted)).toHaveLength(1);
  });
});
