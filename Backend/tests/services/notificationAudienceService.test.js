const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Notification = require('../../models/Notification');
const {
  buildScopedNotificationQuery,
  normalizeBroadcastAudience,
} = require('../../services/notificationAudienceService');

let mongoServer;
const accountId = new mongoose.Types.ObjectId();

const createNotification = (title, fields = {}) => Notification.create({
  user: accountId,
  title,
  body: `${title} body`,
  category: 'system',
  source: 'system',
  ...fields,
});

const visibleTitles = async (role) => {
  const docs = await Notification.find(buildScopedNotificationQuery({
    userId: accountId,
    role,
  })).sort({ title: 1 }).lean();
  return docs.map(({ title }) => title);
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(async () => {
  await Notification.deleteMany({});
  await Promise.all([
    createNotification('buyer explicit', { targetRole: 'user', audience: 'specific' }),
    createNotification('seller explicit', { targetRole: 'seller', audience: 'specific' }),
    createNotification('shopping both', { targetRole: 'both', audience: 'specific' }),
    createNotification('admin explicit', { targetRole: 'admin', audience: 'specific' }),
    createNotification('buyer broadcast fallback', { audience: 'all_users' }),
    createNotification('seller broadcast fallback', { audience: 'all_sellers' }),
    createNotification('ambiguous legacy broadcast', {
      category: 'announcement',
      source: 'admin_broadcast',
    }),
    createNotification('legacy buyer order', {
      category: 'order',
      linkTo: '/user-dashboard/order/detail/one',
    }),
    createNotification('legacy seller category', { category: 'seller' }),
    createNotification('legacy seller route', {
      category: 'order',
      linkTo: '/seller/orders/one',
    }),
    createNotification('legacy absolute seller route', {
      category: 'system',
      linkTo: 'https://rozare.com/seller-dashboard/payments',
    }),
    createNotification('legacy admin route', {
      category: 'system',
      linkTo: '/admin-dashboard/users',
    }),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('persistent notification role isolation', () => {
  test('a buyer cannot read seller/admin snapshots or legacy seller routes', async () => {
    await expect(visibleTitles('user')).resolves.toEqual([
      'buyer broadcast fallback',
      'buyer explicit',
      'legacy buyer order',
      'shopping both',
    ]);
  });

  test('a seller receives seller operations and shopping notifications, not buyer/admin broadcasts', async () => {
    await expect(visibleTitles('seller')).resolves.toEqual([
      'legacy absolute seller route',
      'legacy buyer order',
      'legacy seller category',
      'legacy seller route',
      'seller broadcast fallback',
      'seller explicit',
      'shopping both',
    ]);
  });

  test('a current admin sees only admin snapshots and safe legacy admin/system intent', async () => {
    await expect(visibleTitles('admin')).resolves.toEqual([
      'admin explicit',
      'legacy admin route',
    ]);
  });

  test('invalid or missing roles fail closed and unread queries share the same boundary', async () => {
    await expect(visibleTitles('guest')).resolves.toEqual([]);
    await expect(Notification.countDocuments(buildScopedNotificationQuery({
      userId: accountId,
      role: 'user',
      read: false,
    }))).resolves.toBe(4);
  });

  test('accepts only supported broadcast audiences', () => {
    expect(normalizeBroadcastAudience('all_users')).toBe('all_users');
    expect(normalizeBroadcastAudience(' all_sellers ')).toBe('all_sellers');
    expect(normalizeBroadcastAudience('everyone')).toBeNull();
    expect(normalizeBroadcastAudience()).toBeNull();
  });
});
